const db = require("../config/db");

/**
 * Records one successful-generation analytics event. Deliberately narrow -
 * only ids/metrics, never the generated or uploaded image - this table is
 * the source of truth for admin dashboard generation analytics.
 */
async function recordEvent({ userId, styleId, categoryId, generationTimeMs }) {
  const result = await db.query(
    `
    INSERT INTO generation_events (user_id, style_id, category_id, generation_time_ms, success)
    VALUES ($1, $2, $3, $4, true)
    RETURNING id
    `,
    [userId, styleId ?? null, categoryId ?? null, generationTimeMs ?? null]
  );
  return result.rows[0];
}

module.exports = {
  recordEvent,
};
