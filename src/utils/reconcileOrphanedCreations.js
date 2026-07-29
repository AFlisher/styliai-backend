/**
 * SEC-8.1A — reconciliation of storage objects that no row points at any more.
 *
 * Deleting a creation never used to delete its stored objects, so orphans have
 * been accumulating since the feature shipped. At the time this was written the
 * `creations` bucket held 8 objects against 2 rows. The controller fix stops the
 * bleeding; this sweeps what already leaked, and picks up anything a later
 * storage failure leaves behind.
 *
 * Usage:
 *   node src/utils/reconcileOrphanedCreations.js [--delete] [--bucket=NAME]
 *                                                [--min-age-hours=N] [--limit=N]
 *
 * ─── Safety properties ────────────────────────────────────────────────────
 *
 * DRY RUN IS THE DEFAULT. Deleting requires `--delete`, spelled out. This is the
 * opposite default to backfillThumbnails.js, and deliberately so: that script
 * only ever creates objects, this one destroys them irreversibly. There is no
 * undo and no recycle bin — a mistake here is permanent data loss.
 *
 * An object is a deletion candidate only when NOTHING in the database points at
 * it. The predicate is `creationAssetCleanup.isReferenced`, the very same one
 * the delete path uses, checked against every column in the schema that can
 * hold a storage URL. Sharing it is the point: two implementations of "is this
 * still in use" would eventually disagree, and the disagreement would surface
 * as deleted live images.
 *
 * A MINIMUM AGE (24h by default) is enforced on top of that. An object is
 * uploaded before its row is written, so a generation in flight is briefly
 * indistinguishable from an orphan. Without this window a concurrent run could
 * delete an image out from under a request that was about to reference it. Do
 * not set it to 0 on a live system.
 *
 * ─── Why `style-images` is not the default target ─────────────────────────
 *
 * `style-images` is the admin catalog bucket. It once also held user
 * generations in the same `original/` and `thumbs/` prefixes with
 * indistinguishable UUID filenames; SEC-8.1B-1 separated them, so generations
 * now go to `creations` and that bucket is catalog-only. It stays reachable
 * here for rows that predate the separation and for anything pointed at it
 * through `migrateCreations`, but it must still be asked for explicitly: the
 * reference check does protect covers (`styles.cover_image` points at them),
 * yet the blast radius of a bug in that check there is the entire product
 * catalog rather than a handful of stale generations. Read a dry run carefully
 * before adding `--delete`.
 *
 * Note what the separation changed for THIS script: `creations` is no longer
 * just legacy Stability output, it is where every generated image lives. An
 * object orphaned by a failed creation-row insert now lands in the default
 * target and will be deleted once it passes the age guard. That is the
 * intended behaviour, and it is also why the dry-run default matters more
 * than it did before — a mistake here now costs a user's generated image.
 */

require("dotenv").config();

const db = require("../config/db");
const supabase = require("../config/supabase");
const { isReferenced, DELETABLE_BUCKETS } = require("../services/creationAssetCleanup");

const DEFAULT_BUCKET = "creations";
const DEFAULT_MIN_AGE_HOURS = 24;
/** Supabase caps a listing page at 1000; paginate rather than truncate. */
const PAGE_SIZE = 1000;
/** remove() takes a batch; keep requests a sane size. */
const DELETE_BATCH = 100;

function parseArgs(argv) {
  const bucketArg = argv.find((a) => a.startsWith("--bucket="));
  const ageArg = argv.find((a) => a.startsWith("--min-age-hours="));
  const limitArg = argv.find((a) => a.startsWith("--limit="));

  return {
    bucket: bucketArg ? bucketArg.split("=")[1] : DEFAULT_BUCKET,
    // Dry run unless --delete is spelled out.
    dryRun: !argv.includes("--delete"),
    minAgeHours: ageArg ? Number(ageArg.split("=")[1]) : DEFAULT_MIN_AGE_HOURS,
    limit: limitArg ? Number(limitArg.split("=")[1]) : undefined,
  };
}

/**
 * Every object in a bucket, recursing into prefixes.
 *
 * Both layouts in use are covered without hardcoding either: legacy Stability
 * originals sit at the bucket root, while everything written through
 * uploadOriginalWithThumbnail lands under `original/` and `thumbs/`.
 */
async function listAllObjects(bucket, prefix = "") {
  const objects = [];
  let offset = 0;

  for (;;) {
    const { data, error } = await supabase.storage
      .from(bucket)
      .list(prefix, { limit: PAGE_SIZE, offset, sortBy: { column: "name", order: "asc" } });

    if (error) throw new Error(`list ${bucket}/${prefix} failed: ${error.message}`);
    if (!data || data.length === 0) break;

    for (const entry of data) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      // Supabase reports a synthetic folder row with a null id.
      if (entry.id === null || entry.id === undefined) {
        objects.push(...(await listAllObjects(bucket, path)));
      } else {
        objects.push({ path, createdAt: entry.created_at || null });
      }
    }

    if (data.length < PAGE_SIZE) break;
    offset += data.length;
  }

  return objects;
}

function ageHours(createdAt) {
  if (!createdAt) return Infinity; // unknown age: treat as old, the age guard is a floor not a filter
  const ms = Date.now() - new Date(createdAt).getTime();
  return Number.isFinite(ms) ? ms / 3_600_000 : Infinity;
}

async function main() {
  const { bucket, dryRun, minAgeHours, limit } = parseArgs(process.argv.slice(2));

  if (!DELETABLE_BUCKETS.has(bucket)) {
    console.error(
      `[reconcile] Refusing to operate on "${bucket}". Allowed: ${[...DELETABLE_BUCKETS].join(", ")}.`
    );
    process.exitCode = 1;
    return;
  }
  if (!Number.isFinite(minAgeHours) || minAgeHours < 0) {
    console.error("[reconcile] --min-age-hours must be a non-negative number.");
    process.exitCode = 1;
    return;
  }

  console.log(
    `[reconcile] bucket=${bucket} minAgeHours=${minAgeHours} ${dryRun ? "DRY RUN (no deletes)" : "*** DELETING ***"}`
  );
  if (bucket === "style-images") {
    console.warn(
      "[reconcile] WARNING: style-images holds admin catalog covers alongside user generations " +
        "under the same prefixes. Read the dry-run output in full before adding --delete."
    );
  }
  if (minAgeHours === 0) {
    console.warn(
      "[reconcile] WARNING: --min-age-hours=0 can delete an image that has been uploaded but " +
        "whose row has not been written yet. Never do this against a live system."
    );
  }

  const objects = await listAllObjects(bucket);
  console.log(`[reconcile] ${objects.length} objects in ${bucket}.`);

  const orphans = [];
  let referenced = 0;
  let tooNew = 0;

  for (const object of objects) {
    if (ageHours(object.createdAt) < minAgeHours) {
      tooNew++;
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    if (await isReferenced({ bucket, path: object.path })) {
      referenced++;
      continue;
    }
    orphans.push(object);
    if (limit && orphans.length >= limit) break;
  }

  console.log(`[reconcile] referenced: ${referenced}`);
  console.log(`[reconcile] skipped (younger than ${minAgeHours}h): ${tooNew}`);
  console.log(`[reconcile] orphaned: ${orphans.length}`);
  orphans.forEach((o) => console.log(`[reconcile]   ${dryRun ? "would delete" : "deleting"}: ${bucket}/${o.path}`));

  if (orphans.length === 0 || dryRun) {
    if (dryRun && orphans.length > 0) {
      console.log("[reconcile] Dry run only. Re-run with --delete to remove the objects listed above.");
    }
    return;
  }

  let deleted = 0;
  for (let i = 0; i < orphans.length; i += DELETE_BATCH) {
    const paths = orphans.slice(i, i + DELETE_BATCH).map((o) => o.path);
    // eslint-disable-next-line no-await-in-loop
    const { error } = await supabase.storage.from(bucket).remove(paths);
    if (error) {
      console.error(`[reconcile] batch delete failed: ${error.message}`);
      process.exitCode = 1;
    } else {
      deleted += paths.length;
    }
  }

  console.log(`[reconcile] ==== deleted ${deleted}/${orphans.length} orphaned objects from ${bucket}. ====`);
}

// Only when run as a script. Unlike backfillThumbnails.js this guard is
// necessary: the argument parsing and the age guard are exactly the logic worth
// unit-testing, and importing the module must not open a pool or start deleting.
if (require.main === module) {
  main()
    .catch((err) => {
      console.error("[reconcile] Fatal error:", err.message);
      process.exitCode = 1;
    })
    .finally(() => db.pool.end());
}

module.exports = { __testing: { parseArgs, ageHours, listAllObjects } };
