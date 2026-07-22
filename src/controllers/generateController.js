const generationService = require("../services/generation/generationService");
const walletService = require("../services/wallet/walletService");
const styleModel = require("../models/styleModel");
const creationsModel = require("../models/creationsModel");
const notificationModel = require("../models/notificationModel");
const generationEventsModel = require("../models/generationEventsModel");
const { AppError, ErrorCodes } = require("../utils/errors");
const { buildFinalPrompt, PromptValidationError } = require("../utils/promptTemplate");

/**
 * Parses the multipart `fieldValues` part (a JSON string) into an object.
 * Absent/blank -> {}. Malformed JSON or a non-object -> validation error.
 */
function parseFieldValues(raw) {
  if (raw === undefined || raw === null || raw === "") return {};
  if (typeof raw === "object") return raw;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, "fieldValues must be valid JSON.", 400);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, "fieldValues must be a JSON object.", 400);
  }
  return parsed;
}

/**
 * Controller to handle AI style generation requests.
 * Validates request payloads and invokes the generation orchestrator service.
 */
async function generateImage(req, res, next) {
  try {
    const { styleId } = req.body;
    const userId = req.user.id;

    // 1. Validation checks. upload.array puts files in req.files; req.file is
    // kept as a fallback so any single-file route reuse stays valid.
    const files = req.files?.length ? req.files : (req.file ? [req.file] : []);
    if (files.length === 0) {
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

    // Enforce the style's configured source-image bounds before any charge.
    // Columns default to 1/1, so every pre-existing style keeps requiring
    // exactly one image.
    const minImages = style.minImages ?? 1;
    const maxImages = style.maxImages ?? 1;
    if (files.length < minImages || files.length > maxImages) {
      const expected = minImages === maxImages
        ? `exactly ${minImages}`
        : `between ${minImages} and ${maxImages}`;
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        `This style requires ${expected} source image${maxImages === 1 ? "" : "s"} (received ${files.length}).`,
        400
      );
    }

    // 1b. Resolve the dynamic prompt template server-side and validate the
    // user's field values BEFORE any charge. This rejects missing required
    // fields, bad types, unknown placeholders, and injection attempts, and
    // guarantees no unresolved {{token}} ever reaches the provider. Styles
    // with no placeholders resolve to their prompt unchanged (backward
    // compatible). Runs before deduction so invalid input costs nothing.
    let finalPrompt;
    try {
      const fieldValues = parseFieldValues(req.body.fieldValues);
      finalPrompt = buildFinalPrompt({
        prompt: style.prompt,
        fields: style.fields || [],
        values: fieldValues,
      });
    } catch (err) {
      if (err instanceof PromptValidationError) {
        throw new AppError(ErrorCodes.VALIDATION_ERROR, err.message, 400);
      }
      throw err;
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
    let generatedThumbnailUrl;
    const generationStartedAt = Date.now();
    let generationTimeMs;
    try {
      const result = await generationService.generate(files, styleId, finalPrompt);
      generatedImageUrl = result.imageUrl;
      generatedThumbnailUrl = result.thumbnailUrl;
      generationTimeMs = Date.now() - generationStartedAt;
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

    // 4. Record this in the user's creation history. Best-effort: the user
    // already paid credits and has a real generated image back, so a
    // history-write hiccup must never fail an otherwise-successful response.
    let creation;
    try {
      creation = await creationsModel.addCreation({
        userId,
        styleId,
        styleName: style.name,
        imageUrl: generatedImageUrl,
        thumbnailUrl: generatedThumbnailUrl,
      });
    } catch (creationErr) {
      console.error("[generateImage] Failed to record creation history:", creationErr.message);
    }

    // Feed entry for the Notifications screen. Best-effort for the same
    // reason as the creation record above.
    try {
      await notificationModel.createNotification({
        userId,
        type: "generation",
        title: "Your image is ready",
        body: `Your photo was styled with ${style.name}. Check it out in My Creations.`,
      });
    } catch (notifErr) {
      console.error("[generateImage] Failed to create notification:", notifErr.message);
    }

    // Analytics event for the admin dashboard. Best-effort for the same
    // reason as the creation record above - this must never fail an
    // otherwise-successful, already-charged generation response. Never
    // stores the generated or uploaded image, only ids/metrics.
    try {
      await generationEventsModel.recordEvent({
        userId,
        styleId,
        categoryId: style.categoryId ?? null,
        generationTimeMs,
      });
    } catch (eventErr) {
      console.error("[generateImage] Failed to record analytics event:", eventErr.message);
    }

    // 5. Return JSON payload. generationId/categoryId/generationTimeMs are
    // additive fields the client round-trips back on the post-generation
    // feedback submission (POST /api/feedback) - existing clients that
    // ignore them are unaffected.
    return res.status(200).json({
      success: true,
      generatedImageUrl,
      thumbnailUrl: generatedThumbnailUrl,
      generationId: creation?.id ?? null,
      categoryId: style.categoryId ?? null,
      generationTimeMs,
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
