const db = require("../config/db");

async function getCreditPacks({ isEnabled } = {}) {
  let query = `
    SELECT
      id,
      name,
      credits,
      price_display AS "priceDisplay",
      badge,
      description,
      is_enabled AS "isEnabled",
      sort_order AS "sortOrder",
      product_id AS "productId",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM credit_packs
  `;

  const params = [];
  if (isEnabled !== undefined) {
    params.push(isEnabled);
    query += ` WHERE is_enabled = $${params.length}`;
  }

  query += ` ORDER BY sort_order ASC`;

  const result = await db.query(query, params);
  return result.rows;
}

async function createCreditPack({ name, credits, priceDisplay, badge, description, isEnabled, sortOrder }) {
  const result = await db.query(
    `
    INSERT INTO credit_packs
      (name, credits, price_display, badge, description, is_enabled, sort_order)
    VALUES
      ($1, $2, $3, $4, $5, $6,
       COALESCE($7, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM credit_packs)))
    RETURNING
      id,
      name,
      credits,
      price_display AS "priceDisplay",
      badge,
      description,
      is_enabled AS "isEnabled",
      sort_order AS "sortOrder",
      product_id AS "productId",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    `,
    [name, credits, priceDisplay, badge, description, isEnabled, sortOrder ?? null]
  );

  return result.rows[0];
}

async function updateCreditPack(id, { name, credits, priceDisplay, badge, description, isEnabled, sortOrder }) {
  const result = await db.query(
    `
    UPDATE credit_packs
    SET
      name = $1,
      credits = $2,
      price_display = $3,
      badge = $4,
      description = $5,
      is_enabled = $6,
      sort_order = $7,
      updated_at = NOW()
    WHERE id = $8
    RETURNING
      id,
      name,
      credits,
      price_display AS "priceDisplay",
      badge,
      description,
      is_enabled AS "isEnabled",
      sort_order AS "sortOrder",
      product_id AS "productId",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    `,
    [name, credits, priceDisplay, badge, description, isEnabled, sortOrder, id]
  );

  return result.rows[0];
}

async function deleteCreditPack(id) {
  const result = await db.query(
    `
    DELETE FROM credit_packs
    WHERE id = $1
    RETURNING id
    `,
    [id]
  );

  return result.rows[0];
}

module.exports = {
  getCreditPacks,
  createCreditPack,
  updateCreditPack,
  deleteCreditPack,
};
