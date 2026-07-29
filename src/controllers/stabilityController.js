const stabilityService = require("../services/stabilityService");
const walletService = require("../services/wallet/walletService");
const creationsModel = require("../models/creationsModel");
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
// These bounds are deliberately applied to the ADMIN path only. The
// user-facing generateImage below is the same class of gap but is tracked
// separately as SEC-9.2, and it is bounded meanwhile by an atomic wallet
// charge that this path has no equivalent of.
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
 * Validates the admin preview payload, throwing a 400 AppError on the first
 * problem. Runs entirely locally - no provider call is made for input we can
 * reject ourselves, which is the point.
 *
 * @returns {{prompt: string, negativePrompt: string|undefined, aspectRatio: string|undefined, style: string|undefined}}
 */
function validatePreviewInput({ prompt, negativePrompt, aspectRatio, style }) {
  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, "prompt is required.", 400);
  }

  if (prompt.length > MAX_PROMPT_LENGTH) {
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
    try {
      await creationsModel.addCreation({
        userId,
        styleId: resolvedStyle ? resolvedStyle.id : null,
        styleName: resolvedStyle ? resolvedStyle.name : CREATION_STYLE_NAME,
        imageUrl: result.imageUrl,
        thumbnailUrl: result.thumbnailUrl,
      });
    } catch (creationErr) {
      console.error("[stabilityController] Failed to record creation history:", creationErr.message);
    }

    return res.status(200).json({
      success: true,
      imageUrl: result.imageUrl,
      thumbnailUrl: result.thumbnailUrl,
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
  MAX_PROMPT_LENGTH,
  MAX_NEGATIVE_PROMPT_LENGTH,
  ALLOWED_ASPECT_RATIOS,
  ALLOWED_STYLE_PRESETS,
};
