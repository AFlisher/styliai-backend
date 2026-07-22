const { z } = require("zod");
const generationFeedbackModel = require("../models/generationFeedbackModel");
const { AppError, ErrorCodes } = require("../utils/errors");

const MAX_COMMENT_LENGTH = 2000;
const MAX_APP_VERSION_LENGTH = 32;

// Empty-string body fields (common from form clients) are treated as
// "not provided" via the .transform below, rather than failing uuid()/min()
// validation.
const emptyToNull = (val) => (val === "" || val === undefined ? null : val);

const submitFeedbackSchema = z.object({
  rating: z.coerce.number().int().min(1).max(5),
  comment: z.preprocess(emptyToNull, z.string().trim().max(MAX_COMMENT_LENGTH).nullable().optional()),
  generationId: z.preprocess(emptyToNull, z.string().uuid().nullable().optional()),
  styleId: z.preprocess(emptyToNull, z.string().uuid().nullable().optional()),
  categoryId: z.preprocess(emptyToNull, z.string().uuid().nullable().optional()),
  generationTimeMs: z.preprocess(emptyToNull, z.coerce.number().int().nonnegative().nullable().optional()),
  appVersion: z.preprocess(emptyToNull, z.string().trim().max(MAX_APP_VERSION_LENGTH).nullable().optional()),
});

/**
 * Records a user's post-generation feedback (star rating + optional
 * comment). Never accepts or stores image data - only ids/metrics/text.
 */
async function submitFeedback(req, res, next) {
  try {
    const parsed = submitFeedbackSchema.safeParse(req.body);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        firstIssue ? `${firstIssue.path.join(".")}: ${firstIssue.message}` : "Invalid feedback payload.",
        400
      );
    }

    const { rating, comment, generationId, styleId, categoryId, generationTimeMs, appVersion } = parsed.data;
    const userId = req.user.id;

    const feedback = await generationFeedbackModel.addFeedback({
      userId,
      generationId,
      styleId,
      categoryId,
      rating,
      comment,
      generationTimeMs,
      appVersion,
    });

    return res.status(201).json({
      id: feedback.id,
      createdAt: feedback.createdAt,
    });
  } catch (err) {
    if (err instanceof AppError) {
      return next(err);
    }
    console.error("[submitFeedback] Failed to save feedback:", err.message);
    return next(new AppError(ErrorCodes.INTERNAL_ERROR, "Failed to submit feedback.", 500));
  }
}

module.exports = {
  submitFeedback,
};
