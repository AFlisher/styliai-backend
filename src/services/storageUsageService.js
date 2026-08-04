const supabase = require("../config/supabase");
const { envInt } = require("../utils/pagination");
const { logger } = require("../utils/logger");

/**
 * SEC-19.1 - a bounded, cached, single-flight storage-usage figure.
 *
 * WHAT WAS WRONG
 * --------------
 * `getStorageUsedMB` walked the ENTIRE `style-images` bucket in a `while
 * (true)` loop on every single dashboard load: 100 objects per request, no
 * cache, no timeout, no iteration cap. That bucket holds both admin-uploaded
 * style art AND every image the platform has ever generated, so the number of
 * sequential round-trips is ceil(N/100) where N grows with total lifetime
 * usage. At 10,000 images that is 100 sequential network calls per dashboard
 * load; at 100,000 it is 1,000, holding an Express handler open for minutes.
 *
 * This is the one place in the codebase where cost scales with total lifetime
 * usage rather than with the size of the answer, and it is the item most
 * likely to become the first real outage - because nothing about it degrades
 * gracefully. It works fine in testing and gets slower every day in production.
 *
 * ATTACK / FAILURE PREVENTED
 * --------------------------
 * The trigger is self-inflicted rather than adversarial, and the feedback loop
 * is what makes it dangerous: the dashboard hangs, an admin refreshes, and
 * each refresh starts ANOTHER full bucket walk while the first is still
 * running. The admin limiter permits 100 requests/minute, so a handful of
 * impatient refreshes multiply into concurrent full scans. Since SEC-19.3
 * those scans also each hold a pooled connection, so this could take the whole
 * API down rather than just the dashboard.
 *
 * Three bounds, each closing a different half of that:
 *   - TTL cache      -> refreshes at most once an hour, so N dashboard loads
 *                       cost one walk instead of N.
 *   - single-flight  -> concurrent callers during a refresh SHARE the one
 *                       in-progress promise rather than each starting their
 *                       own. This is the part that actually kills the refresh
 *                       storm; a TTL alone does not, because every request
 *                       arriving before the first completes still sees an
 *                       empty cache.
 *   - page + deadline caps -> a single refresh can never run unboundedly, even
 *                       the first one after a restart on a huge bucket.
 *
 * WHY CACHED-AND-BOUNDED RATHER THAN A MAINTAINED COUNTER
 * ------------------------------------------------------
 * The audit offers both and calls a running total the "correct fix". A counter
 * is O(1) but needs every upload and delete path to update it, a backfill to
 * seed it, and a reconciliation job for when those drift - and a storage
 * figure that is silently wrong is worse than one that is honestly stale.
 * This implementation takes the audit's option (b) and hardens it past what
 * that option describes: the result carries `asOf` and `truncated` so the
 * dashboard can state its own staleness rather than implying freshness it does
 * not have. The counter remains the right end state and is recorded as a
 * residual, not pretended away.
 */

const BUCKET = "style-images";
const PAGE_SIZE = 100;

const TTL_MS = envInt("ADMIN_STORAGE_STATS_TTL_MS", 60 * 60 * 1000);
// 200 pages x 100 objects = 20,000 objects per refresh. Chosen to be well
// above today's object count and well below the point where one refresh is a
// long-running job. Hitting it is not an error - it is reported as `truncated`
// so the dashboard shows a floor rather than a wrong total presented as exact.
const MAX_PAGES = envInt("ADMIN_STORAGE_STATS_MAX_PAGES", 200);
const DEADLINE_MS = envInt("ADMIN_STORAGE_STATS_DEADLINE_MS", 20_000);

// Module-level, i.e. per-process. Same scope as the existing
// recommendationService memo and the concurrent-generation limiter, and
// deliberately not presented as more: with multiple instances each keeps its
// own copy, which costs one extra walk per instance per TTL and is a bounded,
// acceptable inefficiency rather than a correctness problem.
let cache = null; // { megabytes, asOf, truncated, objectCount }
let inFlight = null; // Promise, the single-flight latch

/**
 * Walks the bucket under a hard page cap and wall-clock deadline.
 *
 * Both caps produce a `truncated` result rather than an exception: a partial
 * figure clearly labelled partial is more useful to an operator than an error
 * card, and the alternative - letting it run - is the defect being fixed.
 */
async function computeUsage(now = Date.now) {
  const startedAt = now();
  let totalBytes = 0;
  let objectCount = 0;
  let offset = 0;
  let truncated = false;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    if (now() - startedAt > DEADLINE_MS) {
      truncated = true;
      break;
    }

    const { data, error } = await supabase.storage
      .from(BUCKET)
      .list("", { limit: PAGE_SIZE, offset });

    if (error) throw error;
    if (!data || data.length === 0) break;

    for (const obj of data) {
      totalBytes += obj.metadata?.size || 0;
    }
    objectCount += data.length;

    if (data.length < PAGE_SIZE) {
      // A short page means the end of the bucket - the only path on which the
      // figure is complete.
      return {
        megabytes: totalBytes / (1024 * 1024),
        objectCount,
        truncated: false,
        asOf: new Date(now()).toISOString(),
      };
    }

    offset += PAGE_SIZE;

    // The loop ran to the page cap without a short page, so there is more.
    if (page === MAX_PAGES - 1) truncated = true;
  }

  return {
    megabytes: totalBytes / (1024 * 1024),
    objectCount,
    truncated,
    asOf: new Date(now()).toISOString(),
  };
}

/**
 * Returns the storage figure, refreshing it at most once per TTL and at most
 * once concurrently.
 *
 * NEVER THROWS. A storage-listing failure must not take down an admin
 * dashboard whose other six metrics come from Postgres and are perfectly
 * healthy - that would let a Supabase Storage incident masquerade as a total
 * analytics outage. On failure it serves the last good value (marked stale) or
 * a null figure the dashboard can render as "unavailable".
 */
async function getStorageUsage({ now = Date.now, force = false } = {}) {
  const fresh = cache && !force && now() - Date.parse(cache.asOf) < TTL_MS;
  if (fresh) return { ...cache, cached: true };

  // Single-flight. The refresh storm in the audit's attack scenario is exactly
  // this: many callers arriving while a walk is already running. They wait on
  // the same promise instead of starting their own.
  if (inFlight) {
    try {
      const result = await inFlight;
      return { ...result, cached: true };
    } catch (_) {
      // The shared refresh failed; fall through to the stale/degraded handling
      // below rather than propagating one caller's failure to all of them.
    }
  }

  inFlight = computeUsage(now);

  try {
    const result = await inFlight;
    cache = result;
    return { ...result, cached: false };
  } catch (err) {
    logger.warn("storage_usage_refresh_failed", {
      bucket: BUCKET,
      // Message only - never the error object, per the SEC-7.3 logging
      // convention established for provider errors.
      error: (err && err.message ? String(err.message) : "unknown").slice(0, 300),
      servingStale: Boolean(cache),
    });

    if (cache) return { ...cache, cached: true, stale: true };

    return {
      megabytes: null,
      objectCount: null,
      truncated: false,
      asOf: null,
      cached: false,
      unavailable: true,
    };
  } finally {
    inFlight = null;
  }
}

/** Test seam: drops the cache and any in-flight latch. */
function resetCache() {
  cache = null;
  inFlight = null;
}

module.exports = {
  getStorageUsage,
  resetCache,
  computeUsage,
  BUCKET,
  PAGE_SIZE,
  TTL_MS,
  MAX_PAGES,
  DEADLINE_MS,
};
