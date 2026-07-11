const generationService = require("../services/generation/generationService");
const walletService = require("../services/wallet/walletService");
const styleModel = require("../models/styleModel");

/**
 * Controller to handle AI style generation requests.
 * Validates request payloads and invokes the generation orchestrator service.
 */
async function generateImage(req, res) {
  try {
    const { styleId } = req.body;
    const userId = req.user.id;

    // 1. Validation checks
    if (!req.file) {
      return res.status(400).json({
        message: "Source image file is required."
      });
    }

    if (!styleId) {
      return res.status(400).json({
        message: "styleId is required."
      });
    }

    // Look up the style early so we know its real configured cost
    // before checking balance or deducting credits.
    const style = await styleModel.getStyleById(styleId);
    if (!style) {
      return res.status(404).json({
        message: "Style preset not found."
      });
    }
    if (!style.isEnabled) {
      return res.status(400).json({
        message: "Style is disabled."
      });
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
    console.error("AI Generation Controller Error:", err);

    if (err.message === "Insufficient balance") {
      return res.status(403).json({
        message: "Insufficient balance"
      });
    }

    if (err.message === "Style preset not found.") {
      return res.status(404).json({
        message: err.message
      });
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
      return res.status(503).json({
        message: "Image generation service is temporarily unavailable."
      });
    }

    return res.status(500).json({
      message: err.message || "An error occurred during image style generation."
    });
  }
}

module.exports = {
  generateImage
};
