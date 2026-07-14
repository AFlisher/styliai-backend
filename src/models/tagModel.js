const db = require("../config/db");

function slugify(name) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function getAllTags() {
  const result = await db.query(`
    SELECT
      id,
      name,
      slug,
      is_enabled AS "isEnabled",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM tags
    ORDER BY name ASC
  `);

  return result.rows;
}

async function createTag({ name, isEnabled = true }) {
  const result = await db.query(
    `
    INSERT INTO tags (name, slug, is_enabled)
    VALUES ($1, $2, $3)
    RETURNING
      id,
      name,
      slug,
      is_enabled AS "isEnabled",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    `,
    [name, slugify(name), isEnabled]
  );

  return result.rows[0];
}

async function updateTag(id, { name, isEnabled }) {
  const result = await db.query(
    `
    UPDATE tags
    SET
      name = $1,
      slug = $2,
      is_enabled = $3,
      updated_at = NOW()
    WHERE id = $4
    RETURNING
      id,
      name,
      slug,
      is_enabled AS "isEnabled",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    `,
    [name, slugify(name), isEnabled, id]
  );

  return result.rows[0];
}

async function deleteTag(id) {
  const result = await db.query(
    `DELETE FROM tags WHERE id = $1 RETURNING id`,
    [id]
  );

  return result.rows[0];
}

module.exports = {
  getAllTags,
  createTag,
  updateTag,
  deleteTag,
};
