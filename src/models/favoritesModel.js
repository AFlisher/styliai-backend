const db = require("../config/db");

async function getFavoriteStyleIds(userId) {
  const result = await db.query(
    `SELECT style_id AS "styleId" FROM favorites WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId]
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
