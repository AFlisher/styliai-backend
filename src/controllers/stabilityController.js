const stabilityService = require("../services/stabilityService");
const { AppError, ErrorCodes } = require("../utils/errors");

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

    if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, "prompt is required.", 400);
    }

    const result = await stabilityService.generateImage({
      prompt,
      negativePrompt,
      aspectRatio,
      style,
    });

    return res.status(200).json({
      success: true,
      imageUrl: result.imageUrl,
    });
  } catch (err) {
    if (err instanceof AppError) {
      return next(err);
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
