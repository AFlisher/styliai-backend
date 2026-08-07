/**
 * SEC-7.3 — structured provider-error logging for the generation path.
 *
 * System Health module addendum: this now ALSO persists to system_incidents
 * via systemIncidentModel, so "recent image-provider incidents" is queryable
 * from the admin dashboard instead of only greppable from Railway's log
 * stream. See systemIncidentModel.js and migration_system_health.sql.
 *
 * Replaces four verbose sites that logged whole error objects:
 * `falProvider`'s `console.dir(err, { depth: null })` plus its raw
 * `err.response` / `err.body` dumps, and the two controllers' bare
 * `console.error(prefix, err)`.
 *
 * The problem was never what those errors contain today. SEC-16.1 checked, and
 * `@fal-ai/client`'s ApiError carries no headers. The problem is that
 * `depth: null` on a third-party object is an unbounded promise: an SDK upgrade
 * that starts attaching a `request` or `config` object — as axios-style clients
 * routinely do — would silently begin dumping the full request, prompt and all,
 * with no code change here and no signal that anything had changed.
 *
 * So this builds its output from an explicit allowlist rather than filtering
 * what arrives. That is the same choice SEC-16.1 made for URL redaction, and
 * for the same reason: matching on what you expect is stable, inspecting what
 * you receive is not.
 *
 * Follows the conventions established by SEC-7.1's logModerationRejection and
 * SEC-7.2's logGenerationBudgetEvent — one line, one JSON object, metadata
 * only, digests never content.
 *
 * Out of scope, and it matters: this controls what is *emitted*. Where those
 * lines go, how long they live, and whether anything redacts at the sink are
 * SEC-16.2 / 16.4 / 16.5 (P5). Today they go to Railway stdout with no drain
 * and no retention policy.
 */

const systemIncidentModel = require("../models/systemIncidentModel");

/**
 * Error messages are allowlisted, but a provider is free to put anything in
 * one — including, plausibly, a fragment of the offending prompt in a
 * moderation refusal. Bounding the length caps how much of anything could ride
 * along, without discarding the field that makes a log line useful.
 */
const MAX_MESSAGE_CHARS = 300;

/** Bounds the key list from a pathological response body. */
const MAX_BODY_KEYS = 12;

function safeMessage(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  return value.length > MAX_MESSAGE_CHARS
    ? `${value.slice(0, MAX_MESSAGE_CHARS)}…[truncated]`
    : value;
}

/**
 * The top-level KEY NAMES of a provider's error body, never their values.
 *
 * This is the debuggability compromise. Knowing a fal error body had
 * `{detail, request_id}` versus `{error, message}` is usually enough to tell
 * one failure class from another and to know what to ask the provider's
 * support about — and it cannot carry a prompt, an image, a token or a header,
 * because no value is ever read.
 */
function bodyKeys(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const keys = Object.keys(body).slice(0, MAX_BODY_KEYS);
  return keys.length ? keys : null;
}

/**
 * Extracts a provider request id under any of the names the three SDKs use.
 * This is the single most useful field for a support conversation and carries
 * no request content.
 */
function requestIdOf(err) {
  const candidate =
    err &&
    (err.requestId ||
      err.request_id ||
      (err.body && (err.body.request_id || err.body.requestId)));
  return typeof candidate === "string" ? candidate : null;
}

function statusOf(err) {
  const candidate =
    err && (err.status || err.statusCode || (err.response && err.response.status));
  return Number.isFinite(candidate) ? candidate : null;
}

/**
 * Logs one provider failure.
 *
 * Every field below is either computed here or explicitly named. The error
 * object itself is never passed to console, never spread, and never
 * serialised — only the specific fields read above.
 *
 * @param {object} params
 * @param {string} params.provider  'fal' | 'gemini' | 'stability'
 * @param {string} params.phase     'provider' | 'download' | 'controller'
 * @param {Error}  params.error
 * @param {string} [params.kind]    backend-derived taxonomy (e.g. StabilityApiError.kind)
 * @param {string} [params.userId]
 * @param {string} [params.endpoint]
 */
function logProviderError({ provider, phase, error, kind, userId, endpoint }) {
  const err = error || {};
  const payload = {
    event: "generation_provider_error",
    provider: provider || null,
    phase: phase || null,
    // Our own classification where we have one - safe by construction,
    // because we assigned it.
    kind: kind || null,
    errorName: typeof err.name === "string" ? err.name : null,
    status: statusOf(err),
    requestId: requestIdOf(err),
    message: safeMessage(err.message),
    // Shape, not content.
    bodyKeys: bodyKeys(err.body) || bodyKeys(err.details),
    userId: userId || null,
    endpoint: endpoint || null,
  };
  console.error(JSON.stringify(payload));

  // System Health module (SEC-20.1/20.2): a second, persisted write of the
  // exact same already-allowlisted fields above - nothing new is computed or
  // exposed here. Fire-and-forget: this runs on the generation error path,
  // which must never be slowed down or failed by a Postgres hiccup.
  // systemIncidentModel.record() never throws (see there), the .catch() is
  // defense in depth around that contract.
  systemIncidentModel
    .record({
      source: "image_provider",
      severity: "error",
      provider: payload.provider,
      phase: payload.phase,
      kind: payload.kind,
      message: payload.message,
      statusCode: payload.status,
      requestId: payload.requestId,
      userId: payload.userId,
      endpoint: payload.endpoint,
      detail: payload.bodyKeys ? { bodyKeys: payload.bodyKeys, errorName: payload.errorName } : { errorName: payload.errorName },
    })
    .catch(() => {});
}

module.exports = {
  logProviderError,
  __testing: { safeMessage, bodyKeys, requestIdOf, statusOf, MAX_MESSAGE_CHARS, MAX_BODY_KEYS },
};
