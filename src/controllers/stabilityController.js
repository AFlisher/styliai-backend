const stabilityService = require("../services/stabilityService");
const walletService = require("../services/wallet/walletService");
const creationsModel = require("../models/creationsModel");
const { withDeliveryUrls } = require("../utils/creationImageUrl");
const styleModel = require("../models/styleModel");
const { AppError, ErrorCodes } = require("../utils/errors");
const {
  MODERATION_MESSAGE,
  logModerationRejection,
} = require("../utils/contentModeration");
const { logProviderError } = require("../utils/providerErrorLog");

// Flat per-generation cost, since (unlike /api/generate) there is no style
// entity here to carry a per-item credit_cost. Configurable so pricing can
// change without a deploy; every existing style defaults to 1 credit, so 1
// is the consistent default here too.
const GENERATION_COST = Number(process.env.STABILITY_GENERATION_COST) || 1;

// creations.style_id is nullable (ON DELETE SET NULL) precisely for
// non-style-preset generations like this; style_name is NOT NULL, so a
// fixed label stands in for the style entity /api/generate would normally
// supply.
const CREATION_STYLE_NAME = "Stability AI Text-to-Image";

// ---------------------------------------------------------------------------
// SEC-15.8: input bounds for the admin preview endpoint.
//
// This endpoint calls a per-image metered provider with no wallet charge, so
// anything it forwards costs real money. Before this, `prompt` was checked
// only for non-emptiness and negativePrompt/aspectRatio/style were passed
// through unexamined - a 50,000-character prompt and a nonsense aspect ratio
// both reached the provider verbatim (measured, not assumed).
//
// SEC-9.2 (Phase 7) - these bounds now apply to BOTH paths. The paragraph
// above described the state before this phase: the admin preview was bounded
// and the user-facing generateImage below was not, because the wallet charge
// gave the user path a cost ceiling the admin path lacked. That made the gap
// lower-risk, not closed - a credit bought a 100 kB prompt and an unvalidated
// aspect_ratio, both forwarded verbatim to a metered provider that would
// reject them, costing a round-trip and forcing a refund. The same validator
// is now shared by both, which is the whole reason it was written as a
// standalone function rather than inline.
// ---------------------------------------------------------------------------

// Stability's own documented ceiling for this endpoint. Also >2x the largest
// prompt in the live catalog (4,643 chars; average 2,034), so it cannot reject
// realistic work. Anything longer is refused locally for free instead of being
// paid for and then rejected upstream.
const MAX_PROMPT_LENGTH = 10000;

// Tighter, because negative prompts genuinely are: the longest in the live
// catalog is 956 characters, so this leaves roughly 2x headroom.
const MAX_NEGATIVE_PROMPT_LENGTH = 2000;

// Exact-match allow-lists of the values api.stability.ai accepts for
// stable-image/generate/core. Allow-list rather than deny-list: an unknown
// value is refused, so a provider-side addition needs a deliberate change here
// rather than silently becoming reachable. The Admin Dashboard sends neither
// parameter today (it posts `{ prompt }` alone), so these constrain only
// hand-made requests.
const ALLOWED_ASPECT_RATIOS = new Set([
  "21:9", "16:9", "3:2", "5:4", "1:1", "4:5", "2:3", "9:16", "9:21",
]);

const ALLOWED_STYLE_PRESETS = new Set([
  "3d-model", "analog-film", "anime", "cinematic", "comic-book", "digital-art",
  "enhance", "fantasy-art", "isometric", "line-art", "low-poly",
  "modeling-compound", "neon-punk", "origami", "photographic", "pixel-art",
  "tile-texture",
]);

/**
 * Validates generation parameters, throwing a 400 AppError on the first
 * problem. Runs entirely locally - no provider call is made for input we can
 * reject ourselves, which is the point.
 *
 * `requirePrompt` is the only difference between the two callers. The admin
 * preview has no style catalog behind it, so a prompt is mandatory; the
 * user-facing endpoint accepts `styleId` INSTEAD of a prompt and resolves the
 * text server-side afterwards, so an absent prompt is legal there and is
 * checked after resolution.
 *
 * @returns {{prompt: string|undefined, negativePrompt: string|undefined, aspectRatio: string|undefined, style: string|undefined}}
 */
function validateGenerationParams(
  { prompt, negativePrompt, aspectRatio, style },
  { requirePrompt = true } = {}
) {
  // Absent is only acceptable when the caller may supply a styleId instead.
  // Present-but-unusable (empty string, non-string) is always a refusal, even
  // on the optional path: falling through to style resolution would generate
  // something other than what was asked for.
  const promptSupplied = prompt !== undefined && prompt !== null;
  if (requirePrompt || promptSupplied) {
    if (typeof prompt !== "string" || !prompt.trim()) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, "prompt is required.", 400);
    }
  }

  if (typeof prompt === "string" && prompt.length > MAX_PROMPT_LENGTH) {
    throw new AppError(
      ErrorCodes.VALIDATION_ERROR,
      `prompt must be at most ${MAX_PROMPT_LENGTH} characters.`,
      400
    );
  }

  if (negativePrompt !== undefined && negativePrompt !== null) {
    if (typeof negativePrompt !== "string") {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, "negativePrompt must be a string.", 400);
    }
    if (negativePrompt.length > MAX_NEGATIVE_PROMPT_LENGTH) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        `negativePrompt must be at most ${MAX_NEGATIVE_PROMPT_LENGTH} characters.`,
        400
      );
    }
  }

  // Absent is fine - both are optional upstream. Present-but-unrecognised is
  // not: it would be forwarded, billed, and rejected by the provider.
  if (aspectRatio !== undefined && aspectRatio !== null && !ALLOWED_ASPECT_RATIOS.has(aspectRatio)) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, "aspectRatio is not a supported value.", 400);
  }

  if (style !== undefined && style !== null && !ALLOWED_STYLE_PRESETS.has(style)) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, "style is not a supported value.", 400);
  }

  return { prompt, negativePrompt, aspectRatio, style };
}

/**
 * The admin-preview caller (SEC-15.8). Retained as a named wrapper because it
 * is part of this module's exported surface and is asserted directly by tests -
 * the bounds on a paid endpoint are a security property, not an implementation
 * detail, so the name they are asserted through stays stable.
 */
function validatePreviewInput(input) {
  return validateGenerationParams(input, { requirePrompt: true });
}

// Maps a StabilityApiError.kind to an AppError so the global error handler
// returns the same shape as every other endpoint. Kept local to this
// controller so the service layer stays free of the AppError/ErrorCodes
// concept - it only knows about Stability's own error semantics.
const KIND_TO_APP_ERROR = {
  validation_error: (message) => new AppError(ErrorCodes.VALIDATION_ERROR, message, 400),
  bad_request: (message) => new AppError(ErrorCodes.VALIDATION_ERROR, message, 400),
  // SEC-7.1. 422 rather than 400: the request was well-formed and we
  // understood it, we are refusing it on policy. The message is uniform and
  // carries no provider detail, so it cannot be used to tune prompts against
  // the classifier.
  content_moderation: () =>
    new AppError(ErrorCodes.CONTENT_MODERATED, MODERATION_MESSAGE, 422),
  missing_api_key: () =>
    new AppError(ErrorCodes.PROVIDER_UNAVAILABLE, "Image generation service is not configured.", 503),
  invalid_api_key: () =>
    new AppError(ErrorCodes.PROVIDER_UNAVAILABLE, "Image generation service is temporarily unavailable.", 503),
  insufficient_credits: () =>
    new AppError(ErrorCodes.PROVIDER_UNAVAILABLE, "Image generation service is temporarily unavailable.", 503),
  rate_limited: (message) => new AppError(ErrorCodes.RATE_LIMITED, message, 429),
  timeout: (message) => new AppError(ErrorCodes.PROVIDER_UNAVAILABLE, message, 503),
  network_error: (message) => new AppError(ErrorCodes.PROVIDER_UNAVAILABLE, message, 503),
  upload_failed: (message) => new AppError(ErrorCodes.INTERNAL_ERROR, message, 500),
  provider_error: (message) => new AppError(ErrorCodes.PROVIDER_UNAVAILABLE, message, 503),
};

// Shared by generateImage and adminPreviewGenerate so the StabilityApiError
// -> AppError mapping lives in exactly one place.
function handleStabilityError(err, next, context = {}) {
  if (err instanceof AppError) {
    return next(err);
  }

  if (err instanceof stabilityService.StabilityApiError) {
    if (err.kind === "content_moderation") {
      // SEC-7.1: a policy refusal is not an error condition of ours, so it is
      // recorded as its own structured event rather than as a provider error.
      logModerationRejection({
        userId: context.userId,
        endpoint: context.endpoint,
        provider: "stability",
        stage: "prompt",
        categories: [],
        reason: "http_403",
        prompt: context.prompt,
      });
      return next(KIND_TO_APP_ERROR.content_moderation());
    }

    // SEC-7.3: err.details is the provider's parsed error BODY. Logging it
    // whole meant whatever Stability chose to echo back went to stdout.
    logProviderError({
      provider: "stability",
      phase: "provider",
      error: err,
      kind: err.kind,
      userId: context.userId,
      endpoint: context.endpoint,
    });
    const buildAppError = KIND_TO_APP_ERROR[err.kind] || KIND_TO_APP_ERROR.provider_error;
    return next(buildAppError(err.message));
  }

  // SEC-7.3: previously logged the whole error object.
  logProviderError({
    provider: "stability",
    phase: "controller",
    error: err,
    userId: context.userId,
    endpoint: context.endpoint,
  });
  return next(new AppError(ErrorCodes.INTERNAL_ERROR, err.message || "Image generation failed.", 500));
}

/**
 * POST /api/ai/generate
 * Body: { prompt?, styleId?, negativePrompt?, aspectRatio?, style? }
 * At least one of prompt/styleId is required. GET /api/styles never exposes
 * a style's prompt/negativePrompt to the client (proprietary text, same
 * protection /api/generate already relies on) - so when the client sends a
 * styleId instead of raw prompt text, it's resolved here server-side,
 * mirroring exactly how /api/generate resolves its own prompt.
 * Isolated from the /api/generate (style-transfer) and tagging pipelines -
 * this only talks to stabilityService.
 */
async function generateImage(req, res, next) {
  try {
    let { prompt, negativePrompt, aspectRatio, style } = req.body;
    const { styleId } = req.body;
    const userId = req.user.id;

    // SEC-9.2: bound the CLIENT-SUPPLIED parameters first - before the style
    // lookup, before the wallet charge, and before anything reaches the paid
    // provider. Ordering is the security-relevant part: validation that runs
    // after the deduction turns a rejected request into a charge-and-refund
    // pair, and validation that runs after the provider call is not validation
    // at all, it is a second opinion on something already paid for.
    //
    // `requirePrompt: false` because this endpoint legitimately accepts a
    // styleId INSTEAD of prompt text; the resolved-prompt check below still
    // guarantees something usable exists before proceeding.
    validateGenerationParams(
      { prompt, negativePrompt, aspectRatio, style },
      { requirePrompt: false }
    );

    let resolvedStyle = null;
    if ((!prompt || !prompt.trim()) && styleId) {
      resolvedStyle = await styleModel.getStyleById(styleId);
      if (resolvedStyle) {
        prompt = resolvedStyle.prompt;
        if (!negativePrompt) {
          negativePrompt = resolvedStyle.negativePrompt;
        }
      }
    }

    // Deliberately NOT re-run through validateGenerationParams: `prompt` may
    // now hold catalog text this server owns, and applying a user-input length
    // cap to our own curated data would turn an over-long style - an operator
    // mistake, fixable in the dashboard - into a 400 blaming the user for it.
    // The client-supplied values were already bounded above; this is only the
    // "something usable exists" check.
    if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, "prompt is required.", 400);
    }

    // Deduct BEFORE calling the paid provider - same atomic, row-locked
    // check-and-deduct flow /api/generate uses (walletService.deductBalance),
    // so no user can call this endpoint for free or race past their balance.
    await walletService.deductBalance(
      userId,
      GENERATION_COST,
      "generation",
      "AI image generated (Stability)"
    );

    let result;
    try {
      result = await stabilityService.generateImage({
        prompt,
        negativePrompt,
        aspectRatio,
        style,
      });
    } catch (genErr) {
      // Generation failed after the charge already succeeded - refund so the
      // user isn't charged for a failed generation, mirroring generateController.
      try {
        await walletService.addBalance(
          userId,
          GENERATION_COST,
          "refund",
          "Refund for failed Stability generation"
        );
      } catch (refundErr) {
        console.error(
          "[FINANCIAL INCONSISTENCY] Refund failed after a failed Stability generation - user was charged but never received a refund.",
          {
            userId,
            amount: GENERATION_COST,
            originalError: genErr && genErr.message,
            refundError: refundErr && refundErr.message,
          }
        );
        throw refundErr;
      }
      throw genErr;
    }

    // Record this in the user's creation history, same as /api/generate.
    // Best-effort: the user already paid credits and has a real generated
    // image back, so a history-write hiccup must never fail an otherwise-
    // successful response.
    let creation;
    try {
      creation = await creationsModel.addCreation({
        userId,
        styleId: resolvedStyle ? resolvedStyle.id : null,
        styleName: resolvedStyle ? resolvedStyle.name : CREATION_STYLE_NAME,
        imageUrl: result.imageUrl,
        thumbnailUrl: result.thumbnailUrl,
      });
    } catch (creationErr) {
      console.error("[stabilityController] Failed to record creation history:", creationErr.message);
    }

    // SEC-8.1B-2: stable delivery URLs, same rule as /api/creations. Falls
    // back to the storage URLs when the history row could not be written -
    // there is no id to address, and the user must still get their image.
    const delivery = creation
      ? withDeliveryUrls(req, {
          id: creation.id,
          imageUrl: result.imageUrl,
          thumbnailUrl: result.thumbnailUrl,
        })
      : { imageUrl: result.imageUrl, thumbnailUrl: result.thumbnailUrl };

    return res.status(200).json({
      success: true,
      imageUrl: delivery.imageUrl,
      thumbnailUrl: delivery.thumbnailUrl,
    });
  } catch (err) {
    if (err instanceof AppError) {
      return next(err);
    }

    if (err.message === "Insufficient balance") {
      return next(new AppError(ErrorCodes.INSUFFICIENT_BALANCE, "Insufficient balance", 403));
    }

    return handleStabilityError(err, next, {
      userId: req.user && req.user.id,
      endpoint: `${req.method} ${req.baseUrl}${req.path}`,
      prompt: req.body && req.body.prompt,
    });
  }
}

/**
 * POST /api/admin/ai/generate-preview
 * Admin Dashboard "Test Prompt" tool. Reuses the exact same
 * stabilityService.generateImage() call as the real /api/ai/generate
 * endpoint above, but intentionally skips wallet deduction/refund and
 * creation-history writes - this is an admin testing aid, not a real user
 * generation, and admins have no wallet row to charge against.
 *
 * SEC-8.1B-2: `persist: false`, so it also skips STORAGE. Keeping the output
 * meant two objects per click in `creations` that no row could ever reference -
 * unreferenced by construction, not by accident - in the bucket that is about
 * to hold private user content. The image comes back as a data URI instead,
 * which the dashboard's <img> renders unchanged: no stored object, no orphan,
 * and nothing for the privacy migration to carry.
 */
async function adminPreviewGenerate(req, res, next) {
  try {
    // SEC-15.8: validated before anything reaches the metered provider, so an
    // oversized or malformed payload costs a local 400 rather than an image.
    const { prompt, negativePrompt, aspectRatio, style } = validatePreviewInput(req.body || {});

    const result = await stabilityService.generateImage({
      prompt,
      negativePrompt,
      aspectRatio,
      style,
      persist: false,
    });

    return res.status(200).json({
      success: true,
      imageUrl: result.imageUrl,
    });
  } catch (err) {
    return handleStabilityError(err, next, {
      userId: req.user && req.user.id,
      endpoint: `${req.method} ${req.baseUrl}${req.path}`,
      prompt: req.body && req.body.prompt,
    });
  }
}

module.exports = {
  generateImage,
  adminPreviewGenerate,
  // Exported for tests: the bounds on a paid endpoint are a security property,
  // so they are asserted directly rather than inferred from behaviour.
  validatePreviewInput,
  // SEC-9.2: the shared validator both generation paths now run through.
  validateGenerationParams,
  MAX_PROMPT_LENGTH,
  MAX_NEGATIVE_PROMPT_LENGTH,
  ALLOWED_ASPECT_RATIOS,
  ALLOWED_STYLE_PRESETS,
};
