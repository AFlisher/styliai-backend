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
      credit_cost AS "creditCost",
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

async function getStyles(filters = {}) {
  let query = `
    SELECT
      id,
      category_id AS "categoryId",
      name,
      prompt,
      negative_prompt AS "negativePrompt",
      cover_image AS "coverImage",
      credits_cost AS "creditsCost",
      credit_cost AS "creditCost",
      is_trending AS "isTrending",
      is_premium AS "isPremium",
      is_enabled AS "isEnabled",
      sort_order AS "sortOrder",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM styles
  `;

  const whereClauses = [];
  const params = [];

  if (filters.categoryId) {
    params.push(filters.categoryId);
    whereClauses.push(`category_id = $${params.length}`);
  }

  if (filters.isEnabled !== undefined) {
    params.push(filters.isEnabled);
    whereClauses.push(`is_enabled = $${params.length}`);
  }

  if (whereClauses.length > 0) {
    query += ` WHERE ${whereClauses.join(' AND ')}`;
  }

  query += ` ORDER BY sort_order ASC, created_at ASC`;

  const result = await db.query(query, params);
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
      credit_cost AS "creditCost",
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
      credit_cost,
      is_trending,
      is_premium,
      is_enabled,
      sort_order
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
    )
    RETURNING
      id,
      category_id AS "categoryId",
      name,
      prompt,
      negative_prompt AS "negativePrompt",
      cover_image AS "coverImage",
      credits_cost AS "creditsCost",
      credit_cost AS "creditCost",
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
      style.creditsCost || 1,
      style.creditCost ?? 1,
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
      credit_cost = $7,
      is_trending = $8,
      is_premium = $9,
      is_enabled = $10,
      sort_order = $11,
      updated_at = NOW()
    WHERE id = $12
    RETURNING
      id,
      category_id AS "categoryId",
      name,
      prompt,
      negative_prompt AS "negativePrompt",
      cover_image AS "coverImage",
      credits_cost AS "creditsCost",
      credit_cost AS "creditCost",
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
      style.creditsCost || 1,
      style.creditCost ?? 1,
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
  getStyles,
  getStyleById,
  createStyle,
  updateStyle,
  deleteStyle,
  reorderStyles,
};