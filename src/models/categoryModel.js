const db = require("../config/db");

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
    RETURNING id
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
  createCategory,
  updateCategory,
  deleteCategory,
  reorderCategories,
};