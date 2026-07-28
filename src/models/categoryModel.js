const db = require("../config/db");

/**
 * Every category, including disabled ones. Admin-only - see
 * getPublicCategories for the caller-facing variant, and categoryController
 * for which one is chosen when.
 */
async function getAllCategories() {
  const result = await db.query(`
    SELECT
      id,
      name,
      sort_order AS "sortOrder",
      is_enabled AS "isEnabled",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM categories
    ORDER BY sort_order ASC
  `);

  return result.rows;
}

/**
 * SEC-15.6: enabled categories only.
 *
 * getCategories previously called getAllCategories unconditionally, so every
 * authenticated mobile user received disabled - i.e. unreleased or withdrawn -
 * categories. This mirrors the getStyles/getPublicStyles split that already
 * guards the styles endpoint.
 *
 * The column list is deliberately identical to getAllCategories rather than
 * narrower: this variant restricts which ROWS are visible, not which fields,
 * and the response shape must not change for the mobile app.
 */
async function getPublicCategories() {
  const result = await db.query(`
    SELECT
      id,
      name,
      sort_order AS "sortOrder",
      is_enabled AS "isEnabled",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM categories
    WHERE is_enabled = true
    ORDER BY sort_order ASC
  `);

  return result.rows;
}

async function createCategory({ name, isEnabled }) {
  const result = await db.query(
    `
    INSERT INTO categories
      (name, is_enabled, sort_order)
    VALUES
      ($1, $2, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM categories))
    RETURNING
      id,
      name,
      sort_order AS "sortOrder",
      is_enabled AS "isEnabled",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    `,
    [name, isEnabled]
  );

  return result.rows[0];
}

async function updateCategory(id, { name, isEnabled, sortOrder }) {
  const result = await db.query(
    `
    UPDATE categories
    SET
      name = $1,
      is_enabled = $2,
      sort_order = $3,
      updated_at = NOW()
    WHERE id = $4
    RETURNING
      id,
      name,
      sort_order AS "sortOrder",
      is_enabled AS "isEnabled",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    `,
    [name, isEnabled, sortOrder, id]
  );

  return result.rows[0];
}

async function deleteCategory(id) {
  // Check if the category contains styles
  const stylesResult = await db.query(
    `
    SELECT COUNT(*)::int AS count
    FROM styles
    WHERE category_id = $1
    `,
    [id]
  );

  if (stylesResult.rows[0].count > 0) {
    return {
      hasStyles: true,
    };
  }

  const result = await db.query(
    `
    DELETE FROM categories
    WHERE id = $1
    RETURNING *
    `,
    [id]
  );

  return {
    hasStyles: false,
    deleted: result.rows[0] || null,
  };
}

async function reorderCategories(categories) {
  const client = await db.pool.connect();

  try {
    await client.query("BEGIN");

    for (const category of categories) {
      await client.query(
        `
        UPDATE categories
        SET
          sort_order = $1,
          updated_at = NOW()
        WHERE id = $2
        `,
        [category.sortOrder, category.id]
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
  getAllCategories,
  getPublicCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  reorderCategories,
};