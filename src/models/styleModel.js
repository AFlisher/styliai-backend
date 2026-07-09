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
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM styles
    ORDER BY created_at DESC
  `);

  return result.rows;
}

module.exports = {
  getAllStyles,
};