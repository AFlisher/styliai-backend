const db = require("../config/db");

async function getCreationsByUser(userId) {
  const result = await db.query(
    `
    SELECT
      id,
      style_id AS "styleId",
      style_name AS "styleName",
      image_url AS "imageUrl",
      created_at AS "createdAt"
    FROM creations
    WHERE user_id = $1
    ORDER BY created_at DESC
    `,
    [userId]
  );
  return result.rows;
}

async function addCreation({ userId, styleId, styleName, imageUrl, createdAt }) {
  const result = await db.query(
    `
    INSERT INTO creations (user_id, style_id, style_name, image_url, created_at)
    VALUES ($1, $2, $3, $4, COALESCE($5, CURRENT_TIMESTAMP))
    RETURNING
      id,
      style_id AS "styleId",
      style_name AS "styleName",
      image_url AS "imageUrl",
      created_at AS "createdAt"
    `,
    [userId, styleId ?? null, styleName, imageUrl, createdAt ?? null]
  );
  return result.rows[0];
}

async function deleteCreation(userId, id) {
  const result = await db.query(
    `DELETE FROM creations WHERE id = $1 AND user_id = $2 RETURNING id`,
    [id, userId]
  );
  return result.rows[0];
}

module.exports = {
  getCreationsByUser,
  addCreation,
  deleteCreation,
};
