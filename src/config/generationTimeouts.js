/**
 * SEC-7.2 — the single generation timeout budget.
 *
 * Before this, `stabilityService` had a hard-coded 60s AbortController and the
 * two providers on the main `/api/generate` path — Gemini and fal — had no
 * timeout at all. Three unbounded network operations, counting fal's separate
 * result download.
 *
 * The values live here rather than in each provider for one reason: four
 * independent constants drift, and the existing Stability constant is already
 * proof of it. It was chosen without reference to the Flutter client's
 * `NetworkTimeouts.upload`, so on the one path that *did* have a timeout the
 * client still gave up first and the user never saw the server's clean error.
 *
 * ⚠️ CROSS-REPO COORDINATION, DELIBERATELY NOT RESOLVED HERE.
 *
 * The Flutter client budgets 60s for the whole request — upload, generation and
 * storage. The server's budget below covers only the provider call, and starts
 * after the upload has finished. With both at 60s the client's clock always
 * expires first, so the user sees a generic client timeout rather than the
 * server's PROVIDER_UNAVAILABLE plus a completed refund.
 *
 * The default is kept at the existing 60s so this change introduces no
 * behavioural regression on the Stability path. Making the server answer first
 * requires either lowering this value or raising the client's, and that is a
 * product judgement about how long a user should wait, spanning two
 * repositories. It is a configuration change away, not a code change.
 */

function positiveInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `[generationTimeouts] ${name}="${raw}" is not a positive number; using ${fallback}`
    );
    return fallback;
  }
  return Math.floor(parsed);
}

const generationTimeouts = Object.freeze({
  /**
   * The provider call itself — Gemini's generateContent, fal's subscribe, or
   * Stability's HTTP request. Generation legitimately runs 10–40s and varies
   * with model and load, so this is deliberately generous: a budget tuned to
   * the median refunds real users.
   */
  providerMs: positiveInt("GENERATION_TIMEOUT_MS", 60_000),

  /**
   * fal returns a URL rather than bytes, so its result has to be fetched
   * separately. That is a plain CDN download and has no business inheriting a
   * generation-sized allowance — it was previously unbounded, which meant a
   * stalled CDN connection could hold a request (and up to 50 MB of buffered
   * uploads) indefinitely.
   */
  downloadMs: positiveInt("GENERATION_DOWNLOAD_TIMEOUT_MS", 20_000),
});

module.exports = { generationTimeouts };
