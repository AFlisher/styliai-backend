const db = require("../config/db");
const { FAVORITES_PAGE_MAX } = require("../utils/pagination");

/**
 * SEC-19.2 - bounded, newest first.
 *
 * Favourites are bare style ids rather than rows, so this is far cheaper per
 * item than the creations list and gets a correspondingly looser ceiling
 * (default 1000). It is still a ceiling: the finding is that NO list endpoint
 * had one, not that every list needed the same number. A user cannot favourite
 * more styles than exist in the catalog, so this bound is unreachable in
 * practice - which is exactly what a guard against a future unbounded write
 * path should look like.
 */
async function getFavoriteStyleIds(userId, { limit = FAVORITES_PAGE_MAX } = {}) {
  // Clamped here as well as defaulted, for the same reason as creationsModel:
  // the ceiling belongs with the query, not with the discipline of callers.
  const safeLimit = Number.isFinite(limit) && limit > 0
    ? Math.min(Math.floor(limit), FAVORITES_PAGE_MAX)
    : FAVORITES_PAGE_MAX;

  const result = await db.query(
    `SELECT style_id AS "styleId" FROM favorites
     WHERE user_id = $1
     ORDER BY created_at DESC, style_id DESC
     LIMIT $2`,
    [userId, safeLimit]
  );
  return result.rows.map((row) => row.styleId);
}

async function addFavorite(userId, styleId) {
  await db.query(
    `
    INSERT INTO favorites (user_id, style_id)
    VALUES ($1, $2)
    ON CONFLICT (user_id, style_id) DO NOTHING
    `,
    [userId, styleId]
  );
}

async function removeFavorite(userId, styleId) {
  await db.query(
    `DELETE FROM favorites WHERE user_id = $1 AND style_id = $2`,
    [userId, styleId]
  );
}

module.exports = {
  getFavoriteStyleIds,
  addFavorite,
  removeFavorite,
};
