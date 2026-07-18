const stabilityService = require("../services/stabilityService");
const walletService = require("../services/wallet/walletService");
const { AppError, ErrorCodes } = require("../utils/errors");

// Flat per-generation cost, since (unlike /api/generate) there is no style
// entity here to carry a per-item credit_cost. Configurable so pricing can
// change without a deploy; every existing style defaults to 1 credit, so 1
// is the consistent default here too.
const GENERATION_COST = Number(process.env.STABILITY_GENERATION_COST) || 1;

// Maps a StabilityApiError.kind to an AppError so the global error handler
// returns the same shape as every other endpoint. Kept local to this
// controller so the service layer stays free of the AppError/ErrorCodes
// concept - it only knows about Stability's own error semantics.
const KIND_TO_APP_ERROR = {
  validation_error: (message) => new AppError(ErrorCodes.VALIDATION_ERROR, message, 400),
  bad_request: (message) => new AppError(ErrorCodes.VALIDATION_ERROR, message, 400),
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

/**
 * POST /api/ai/generate
 * Body: { prompt, negativePrompt?, aspectRatio?, style? }
 * Isolated from the /api/generate (style-transfer) and tagging pipelines -
 * this only talks to stabilityService.
 */
async function generateImage(req, res, next) {
  try {
    const { prompt, negativePrompt, aspectRatio, style } = req.body;
    const userId = req.user.id;

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

    return res.status(200).json({
      success: true,
      imageUrl: result.imageUrl,
    });
  } catch (err) {
    if (err instanceof AppError) {
      return next(err);
    }

    if (err.message === "Insufficient balance") {
      return next(new AppError(ErrorCodes.INSUFFICIENT_BALANCE, "Insufficient balance", 403));
    }

    if (err instanceof stabilityService.StabilityApiError) {
      console.error("Stability AI Controller Error:", err.kind, err.message, err.details || "");
      const buildAppError = KIND_TO_APP_ERROR[err.kind] || KIND_TO_APP_ERROR.provider_error;
      return next(buildAppError(err.message));
    }

    console.error("Stability AI Controller Error:", err);
    return next(new AppError(ErrorCodes.INTERNAL_ERROR, err.message || "Image generation failed.", 500));
  }
}

module.exports = {
  generateImage,
};
