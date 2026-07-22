const db = require("../config/db");

async function addFeedback({
  userId,
  generationId,
  styleId,
  categoryId,
  rating,
  comment,
  generationTimeMs,
  appVersion,
}) {
  const result = await db.query(
    `
    INSERT INTO generation_feedback
      (user_id, generation_id, style_id, category_id, rating, comment, generation_time_ms, app_version)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING
      id,
      created_at AS "createdAt"
    `,
    [
      userId,
      generationId ?? null,
      styleId ?? null,
      categoryId ?? null,
      rating,
      comment ?? null,
      generationTimeMs ?? null,
      appVersion ?? null,
    ]
  );
  return result.rows[0];
}

module.exports = {
  addFeedback,
};
