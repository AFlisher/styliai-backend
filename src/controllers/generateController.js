const generationService = require("../services/generation/generationService");
const walletService = require("../services/wallet/walletService");
const styleModel = require("../models/styleModel");
const { AppError, ErrorCodes } = require("../utils/errors");

/**
 * Controller to handle AI style generation requests.
 * Validates request payloads and invokes the generation orchestrator service.
 */
async function generateImage(req, res, next) {
  try {
    const { styleId } = req.body;
    const userId = req.user.id;

    // 1. Validation checks
    if (!req.file) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, "Source image file is required.", 400);
    }

    if (!styleId) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, "styleId is required.", 400);
    }

    // Look up the style early so we know its real configured cost
    // before checking balance or deducting credits.
    const style = await styleModel.getStyleById(styleId);
    if (!style) {
      throw new AppError(ErrorCodes.NOT_FOUND, "Style preset not found.", 404);
    }
    if (!style.isEnabled) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, "Style is disabled.", 400);
    }

    // 2. Atomically check-and-deduct BEFORE calling the AI provider. deductBalance
    // is row-locked, so this closes the race window a separate getBalance()
    // pre-check would leave open, and avoids incurring AI provider cost for
    // requests that shouldn't proceed (the losing concurrent request fails here,
    // before ever reaching the paid AI call).
    await walletService.deductBalance(
      userId,
      style.creditCost,
      "generation",
      "Image generated"
    );

    // 3. Invoke generation orchestration service (uploads image, calls AI)
    let generatedImageUrl;
    try {
      generatedImageUrl = await generationService.generate(req.file, styleId);
    } catch (genErr) {
      // Generation failed after the charge already succeeded - refund so the
      // user isn't charged for a failed generation. A refund failure is a
      // financial inconsistency and must never be silently swallowed.
      try {
        await walletService.addBalance(
          userId,
          style.creditCost,
          "refund",
          "Refund for failed generation"
        );
      } catch (refundErr) {
        console.error(
          "[FINANCIAL INCONSISTENCY] Refund failed after a failed generation - user was charged but never received a refund.",
          {
            userId,
            amount: style.creditCost,
            styleId,
            originalError: genErr && genErr.message,
            refundError: refundErr && refundErr.message,
          }
        );
        throw refundErr;
      }
      throw genErr;
    }

    // 4. Return JSON payload
    return res.status(200).json({
      success: true,
      generatedImageUrl
    });

  } catch (err) {
    if (err instanceof AppError) {
      return next(err);
    }

    console.error("AI Generation Controller Error:", err);

    if (err.message === "Insufficient balance") {
      return next(new AppError(ErrorCodes.INSUFFICIENT_BALANCE, "Insufficient balance", 403));
    }

    // Inspect if error is a Fal AI provider lockout, forbidden, or exhausted balance error
    const errStatus = err.status || err.statusCode || err.response?.status || err.body?.status;
    const errBodyString = typeof err.body === 'object' ? JSON.stringify(err.body) : String(err.body || "");
    const errorText = [
      err.message,
      errBodyString,
      err.response?.statusText
    ].filter(Boolean).join(" ").toLowerCase();

    if (
      errStatus === 403 ||
      errorText.includes("forbidden") ||
      errorText.includes("exhausted balance") ||
      errorText.includes("user is locked")
    ) {
      return next(new AppError(ErrorCodes.PROVIDER_UNAVAILABLE, "Image generation service is temporarily unavailable.", 503));
    }

    return next(new AppError(ErrorCodes.INTERNAL_ERROR, err.message || "An error occurred during image style generation.", 500));
  }
}

module.exports = {
  generateImage
};
