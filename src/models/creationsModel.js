const db = require("../config/db");
const { CREATIONS_PAGE_DEFAULT, CREATIONS_PAGE_MAX } = require("../utils/pagination");

/**
 * SEC-19.2 - one bounded page of a user's creations, newest first.
 *
 * The ORDER BY gains `id DESC` as a tiebreaker so the ordering is TOTAL.
 * Without it, two rows sharing a `created_at` (the column is a plain TIMESTAMP
 * with no uniqueness, and migrateCreations inserts in a tight loop) have no
 * defined relative order, and a cursor built on the timestamp alone would
 * either skip a row or serve one twice on every page boundary.
 *
 * The row-value comparison `(created_at, id) < ($2, $3)` is deliberate rather
 * than an equivalent-looking `created_at < $2 OR (created_at = $2 AND id < $3)`:
 * Postgres can drive the composite idx_creations_user_created index directly
 * from the row-value form, so a deep page costs the same as a shallow one.
 *
 * `limit + 1` is fetched and the extra row discarded by the caller - that is
 * how "is there another page?" is answered without a second COUNT query over
 * the same predicate.
 */
async function getCreationsByUser(
  userId,
  // Defaulted HERE and not only in the controller. A model whose bound depends
  // on every caller remembering to pass one is a model with no bound: the
  // first caller that forgets (a script, a future endpoint, a test) silently
  // gets `undefined + 1` = NaN and an unbounded LIMIT clause. The ceiling has
  // to live with the query it protects.
  { limit = CREATIONS_PAGE_DEFAULT, cursor = null } = {}
) {
  const safeLimit = Number.isFinite(limit) && limit > 0
    ? Math.min(Math.floor(limit), CREATIONS_PAGE_MAX)
    : CREATIONS_PAGE_DEFAULT;

  const params = [userId];
  let predicate = "";

  if (cursor) {
    params.push(cursor.createdAt, cursor.id);
    predicate = `AND (created_at, id) < ($${params.length - 1}::timestamp, $${params.length}::uuid)`;
  }

  params.push(safeLimit + 1);

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
    ${predicate}
    ORDER BY created_at DESC, id DESC
    LIMIT $${params.length}
    `,
    params
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
