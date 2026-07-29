const crypto = require("crypto");

/**
 * SEC-7.1 Stage 1 — preserve the moderation signals the providers already give
 * us, instead of discarding them.
 *
 * Before this, a content-policy refusal was indistinguishable from a provider
 * failure on both pipelines. Gemini's block reasons were never read at all - a
 * safety block surfaced as "Received an empty image buffer", i.e. as an outage.
 * Stability's 403 was collapsed into `bad_request` alongside 400/413/422, so a
 * policy refusal was reported as a malformed request.
 *
 * That conflation is the same class of mistake SEC-0.2 was built to avoid: if
 * "the caller did something disallowed" and "our provider broke" arrive as one
 * signal, you cannot tell a user what happened, cannot audit, and cannot ever
 * see a repeat offender. Everything here exists to keep those two apart.
 *
 * Scope note: this is Stage 1+2 of SEC-7.1 only - surface and declare what the
 * providers already decide. It adds no moderation of its own. Input-image
 * moderation is deliberately a separate future finding, because it introduces a
 * vendor, a per-call cost, and legal/process decisions that are not an
 * engineering call.
 */

/**
 * Thrown when a provider refused on content grounds.
 *
 * Deliberately NOT an AppError: providers live below the controller layer, and
 * the controllers own the HTTP mapping. Deliberately not a generic Error
 * either, which is exactly the conflation being fixed.
 */
class ContentModerationError extends Error {
  /**
   * @param {string} provider - 'gemini' | 'stability' | ...
   * @param {string} stage - 'prompt' or 'output': whether the provider refused
   *   the request before generating, or refused what it generated.
   * @param {string[]} categories - provider-reported categories, if any.
   * @param {string} [reason] - the provider's own short code, for logs only.
   */
  constructor(provider, stage, categories = [], reason = null) {
    super("Content moderation rejected this request.");
    this.name = "ContentModerationError";
    this.isContentModeration = true;
    this.provider = provider;
    this.stage = stage;
    this.categories = categories;
    this.reason = reason;
  }
}

/**
 * The single user-facing message for every moderation rejection.
 *
 * Uniform on purpose, and free of provider detail or category names. Telling a
 * caller which category tripped turns the endpoint into a classifier they can
 * tune prompts against, and the specifics are of no use to an honest user. The
 * detail goes to the log, where an operator can see it and a probing user
 * cannot - the same reasoning as SEC-0.5's blocked response.
 */
const MODERATION_MESSAGE =
  "This request was blocked by our content policy. Please try a different photo or description.";

/**
 * Stable digest of the prompt, for correlating repeat offenders without
 * retaining the content.
 *
 * The prompt is user-authored and is precisely the material a moderation
 * rejection says we should not be storing. A digest makes "the same user sent
 * the same blocked prompt eleven times" answerable while keeping the text
 * itself out of the logs - the same trade SEC-0.2 makes with token digests, and
 * a direct application of SEC-16.1's lesson about what ends up in stdout.
 */
function promptDigest(prompt) {
  if (typeof prompt !== "string" || prompt.length === 0) return null;
  return crypto.createHash("sha256").update(prompt, "utf8").digest("hex").slice(0, 12);
}

/**
 * One structured line per rejection. Metadata only - never the prompt, never
 * the image, never a thumbnail.
 *
 * Keeping content out is not fastidiousness: an audit trail that retains the
 * material a moderation system just refused is itself a liability, and that
 * constraint gets sharper, not softer, as SEC-7.1's later stages add image
 * moderation.
 */
function logModerationRejection({ userId, endpoint, provider, stage, categories, reason, prompt }) {
  console.warn(
    JSON.stringify({
      event: "content_moderation_rejected",
      provider,
      stage,
      categories: Array.isArray(categories) && categories.length ? categories : null,
      reason: reason || null,
      endpoint: endpoint || null,
      userId: userId || null,
      promptDigest: promptDigest(prompt),
    })
  );
}

module.exports = {
  ContentModerationError,
  MODERATION_MESSAGE,
  promptDigest,
  logModerationRejection,
};
