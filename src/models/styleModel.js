const db = require("../config/db");

async function getAllStyles() {
  const result = await db.query(`
    SELECT
      id,
      category_id AS "categoryId",
      name,
      prompt,
      negative_prompt AS "negativePrompt",
      cover_image AS "coverImage",
      credits_cost AS "creditsCost",
      is_trending AS "isTrending",
      is_premium AS "isPremium",
      is_enabled AS "isEnabled",
      sort_order AS "sortOrder",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM styles
    ORDER BY sort_order ASC, created_at ASC
  `);

  return result.rows;
}

async function getStyleById(id) {
  const result = await db.query(
    `
    SELECT
      id,
      category_id AS "categoryId",
      name,
      prompt,
      negative_prompt AS "negativePrompt",
      cover_image AS "coverImage",
      credits_cost AS "creditsCost",
      is_trending AS "isTrending",
      is_premium AS "isPremium",
      is_enabled AS "isEnabled",
      sort_order AS "sortOrder",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM styles
    WHERE id = $1
    `,
    [id]
  );

  return result.rows[0];
}

async function createStyle(style) {
  const result = await db.query(
    `
    INSERT INTO styles (
      category_id,
      name,
      prompt,
      negative_prompt,
      cover_image,
      credits_cost,
      is_trending,
      is_premium,
      is_enabled,
      sort_order
    )
    VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10
    )
    RETURNING
      id,
      category_id AS "categoryId",
      name,
      prompt,
      negative_prompt AS "negativePrompt",
      cover_image AS "coverImage",
      credits_cost AS "creditsCost",
      is_trending AS "isTrending",
      is_premium AS "isPremium",
      is_enabled AS "isEnabled",
      sort_order AS "sortOrder",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    `,
    [
      style.categoryId,
      style.name,
      style.prompt,
      style.negativePrompt,
      style.coverImage,
      style.creditsCost,
      style.isTrending,
      style.isPremium,
      style.isEnabled,
      style.sortOrder
    ]
  );

  return result.rows[0];
}

async function updateStyle(id, style) {
  const result = await db.query(
    `
    UPDATE styles
    SET
      category_id = $1,
      name = $2,
      prompt = $3,
      negative_prompt = $4,
      cover_image = $5,
      credits_cost = $6,
      is_trending = $7,
      is_premium = $8,
      is_enabled = $9,
      sort_order = $10,
      updated_at = NOW()
    WHERE id = $11
    RETURNING
      id,
      category_id AS "categoryId",
      name,
      prompt,
      negative_prompt AS "negativePrompt",
      cover_image AS "coverImage",
      credits_cost AS "creditsCost",
      is_trending AS "isTrending",
      is_premium AS "isPremium",
      is_enabled AS "isEnabled",
      sort_order AS "sortOrder",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    `,
    [
      style.categoryId,
      style.name,
      style.prompt,
      style.negativePrompt,
      style.coverImage,
      style.creditsCost,
      style.isTrending,
      style.isPremium,
      style.isEnabled,
      style.sortOrder,
      id
    ]
  );

  return result.rows[0];
}

async function deleteStyle(id) {
  const result = await db.query(
    `
    DELETE FROM styles
    WHERE id = $1
    RETURNING id
    `,
    [id]
  );

  return result.rows[0];
}

async function reorderStyles(styles) {
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");

    for (const style of styles) {
      await client.query(
        `
        UPDATE styles
        SET sort_order = $1,
            updated_at = NOW()
        WHERE id = $2
        `,
        [style.sortOrder, style.id]
      );
    }

    await client.query("COMMIT");

  } catch (err) {
    await client.query("ROLLBACK");
    throw err;

  } finally {
    client.release();
  }
}

module.exports = {
  getAllStyles,
  getStyleById,
  createStyle,
  updateStyle,
  deleteStyle,
  reorderStyles,
};