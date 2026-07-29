const db = require("../config/db");

async function getCreationsByUser(userId) {
  const result = await db.query(
    `
    SELECT
      id,
      style_id AS "styleId",
      style_name AS "styleName",
      image_url AS "imageUrl",
      thumbnail_url AS "thumbnailUrl",
      created_at AS "createdAt"
    FROM creations
    WHERE user_id = $1
    ORDER BY created_at DESC
    `,
    [userId]
  );
  return result.rows;
}

/**
 * One creation, scoped to its owner. SEC-8.1B-2: the delivery endpoint uses
 * this, so the `user_id` predicate IS the authorization check - a creation is
 * only ever served to the account that owns it, decided here rather than by
 * possession of a URL.
 */
async function getCreationById(userId, id) {
  const result = await db.query(
    `
    SELECT
      id,
      image_url AS "imageUrl",
      thumbnail_url AS "thumbnailUrl"
    FROM creations
    WHERE id = $1 AND user_id = $2
    `,
    [id, userId]
  );
  return result.rows[0];
}

async function addCreation({ userId, styleId, styleName, imageUrl, thumbnailUrl, createdAt }) {
  const result = await db.query(
    `
    INSERT INTO creations (user_id, style_id, style_name, image_url, thumbnail_url, created_at)
    VALUES ($1, $2, $3, $4, $5, COALESCE($6, CURRENT_TIMESTAMP))
    RETURNING
      id,
      style_id AS "styleId",
      style_name AS "styleName",
      image_url AS "imageUrl",
      thumbnail_url AS "thumbnailUrl",
      created_at AS "createdAt"
    `,
    [userId, styleId ?? null, styleName, imageUrl, thumbnailUrl ?? null, createdAt ?? null]
  );
  return result.rows[0];
}

async function deleteCreation(userId, id) {
  const result = await db.query(
    // SEC-8.1A: the stored URLs come back with the deleted row so the caller
    // can erase the underlying storage objects. Returning them from the DELETE
    // itself (rather than SELECTing first) keeps the ownership check and the
    // read of what to erase in one atomic statement - there is no window in
    // which another request could change the row in between.
    `DELETE FROM creations WHERE id = $1 AND user_id = $2
       RETURNING id, image_url AS "imageUrl", thumbnail_url AS "thumbnailUrl"`,
    [id, userId]
  );
  return result.rows[0];
}

module.exports = {
  getCreationsByUser,
  getCreationById,
  addCreation,
  deleteCreation,
};
