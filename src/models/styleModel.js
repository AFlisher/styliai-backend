const db = require("../config/db");
const styleFieldsModel = require("./styleFieldsModel");

async function getAllStyles() {
  const result = await db.query(`
    SELECT
      id,
      category_id AS "categoryId",
      name,
      prompt,
      negative_prompt AS "negativePrompt",
      cover_image AS "coverImage",
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

  return attachFields(result.rows);
}

async function getStyles(filters = {}) {
  // Admin-facing listing - includes tagIds, unlike getPublicStyles, since
  // tags are internal ranking metadata the Admin Dashboard curates but the
  // mobile app never sees (see RecommendationService).
  let query = `
    SELECT
      s.id,
      s.category_id AS "categoryId",
      s.name,
      s.prompt,
      s.negative_prompt AS "negativePrompt",
      s.cover_image AS "coverImage",
      s.credit_cost AS "creditCost",
      s.is_trending AS "isTrending",
      s.is_premium AS "isPremium",
      s.is_enabled AS "isEnabled",
      s.sort_order AS "sortOrder",
      s.created_at AS "createdAt",
      s.updated_at AS "updatedAt",
      s.tags_auto_assigned AS "tagsAutoAssigned",
      COALESCE(array_agg(st.tag_id) FILTER (WHERE st.tag_id IS NOT NULL), ARRAY[]::uuid[]) AS "tagIds"
    FROM styles s
    LEFT JOIN style_tags st ON st.style_id = s.id
  `;

  const whereClauses = [];
  const params = [];

  if (filters.categoryId) {
    params.push(filters.categoryId);
    whereClauses.push(`s.category_id = $${params.length}`);
  }

  if (filters.isEnabled !== undefined) {
    params.push(filters.isEnabled);
    whereClauses.push(`s.is_enabled = $${params.length}`);
  }

  if (filters.isTrending !== undefined) {
    params.push(filters.isTrending);
    whereClauses.push(`s.is_trending = $${params.length}`);
  }

  if (whereClauses.length > 0) {
    query += ` WHERE ${whereClauses.join(' AND ')}`;
  }

  query += ` GROUP BY s.id ORDER BY s.sort_order ASC, s.created_at ASC`;

  const result = await db.query(query, params);
  return attachFields(result.rows);
}

/**
 * Public-facing style list: an explicit column allowlist rather than a
 * blocklist, so `prompt`/`negativePrompt` (and any future sensitive
 * generation-config column, including `tagIds`) are never pulled out of
 * Postgres for this path - not just stripped from the response afterward.
 * Used by GET /api/styles whenever the caller doesn't present a valid admin
 * token (see styleController.getStyles + middleware/adminAuthMiddleware.optionalAdminAuth).
 */
async function getPublicStyles(filters = {}) {
  let query = `
    SELECT
      id,
      category_id AS "categoryId",
      name,
      cover_image AS "coverImage",
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

  if (filters.isTrending !== undefined) {
    params.push(filters.isTrending);
    whereClauses.push(`is_trending = $${params.length}`);
  }

  if (whereClauses.length > 0) {
    query += ` WHERE ${whereClauses.join(' AND ')}`;
  }

  query += ` ORDER BY sort_order ASC, created_at ASC`;

  const result = await db.query(query, params);
  return attachFields(result.rows);
}

/**
 * Public-facing lookup of styles by id, for RecommendationService result
 * hydration. Same allowlist as getPublicStyles - never leaks prompt/tagIds.
 */
async function getPublicStylesByIds(ids) {
  if (ids.length === 0) {
    return [];
  }

  const result = await db.query(
    `
    SELECT
      id,
      category_id AS "categoryId",
      name,
      cover_image AS "coverImage",
      credit_cost AS "creditCost",
      is_trending AS "isTrending",
      is_premium AS "isPremium",
      is_enabled AS "isEnabled",
      sort_order AS "sortOrder",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM styles
    WHERE id = ANY($1::uuid[]) AND is_enabled = true
    `,
    [ids]
  );

  return attachFields(result.rows);
}

async function getStyleById(id) {
  const result = await db.query(
    `
    SELECT
      s.id,
      s.category_id AS "categoryId",
      s.name,
      s.prompt,
      s.negative_prompt AS "negativePrompt",
      s.cover_image AS "coverImage",
      s.credit_cost AS "creditCost",
      s.is_trending AS "isTrending",
      s.is_premium AS "isPremium",
      s.is_enabled AS "isEnabled",
      s.sort_order AS "sortOrder",
      s.created_at AS "createdAt",
      s.updated_at AS "updatedAt",
      s.tags_auto_assigned AS "tagsAutoAssigned",
      COALESCE(array_agg(st.tag_id) FILTER (WHERE st.tag_id IS NOT NULL), ARRAY[]::uuid[]) AS "tagIds"
    FROM styles s
    LEFT JOIN style_tags st ON st.style_id = s.id
    WHERE s.id = $1
    GROUP BY s.id
    `,
    [id]
  );

  const style = result.rows[0];
  if (!style) return style;
  style.fields = await styleFieldsModel.getFieldsForStyle(style.id);
  return style;
}

/** Attaches each style's dynamic input fields, batched to avoid an N+1. */
async function attachFields(rows) {
  if (!rows || rows.length === 0) return rows;
  const byId = await styleFieldsModel.getFieldsForStyleIds(rows.map((r) => r.id));
  for (const row of rows) {
    row.fields = byId.get(row.id) || [];
  }
  return rows;
}

/**
 * Every enabled style's id/categoryId/isTrending/sortOrder/createdAt plus its
 * tagIds, in one query - the candidate set RecommendationService scores
 * against for both the personalized feed and "similar styles". Kept here
 * (not duplicated per-caller) since it's the same shape either entry point
 * needs; RecommendationService is responsible for short-lived memoization of
 * this call, not styleModel.
 */
async function getEnabledStylesWithTags() {
  // Only enabled tags count toward similarity scoring - an admin disabling a
  // tag (e.g. retiring a taxonomy entry) should stop influencing rankings
  // immediately without needing to untag every style that used it.
  const result = await db.query(`
    SELECT
      s.id,
      s.category_id AS "categoryId",
      s.is_trending AS "isTrending",
      s.sort_order AS "sortOrder",
      s.created_at AS "createdAt",
      COALESCE(array_agg(t.id) FILTER (WHERE t.id IS NOT NULL), ARRAY[]::uuid[]) AS "tagIds"
    FROM styles s
    LEFT JOIN style_tags st ON st.style_id = s.id
    LEFT JOIN tags t ON t.id = st.tag_id AND t.is_enabled = true
    WHERE s.is_enabled = true
    GROUP BY s.id
  `);

  return result.rows;
}

/**
 * Styles eligible for backfillTags.js: currently untagged AND not manually
 * curated. tags_auto_assigned = true is a hard invariant here, not just a
 * default filter - a style an admin has manually tagged must never be
 * touched by the backfill, regardless of how it's invoked.
 */
async function getStylesNeedingAutoTag() {
  const result = await db.query(`
    SELECT s.id, s.name, s.prompt, s.category_id AS "categoryId"
    FROM styles s
    LEFT JOIN style_tags st ON st.style_id = s.id
    WHERE s.tags_auto_assigned = true AND st.style_id IS NULL
    ORDER BY s.created_at ASC
  `);

  return result.rows;
}

/**
 * Replaces the full tag set for a style. Accepts a `queryable` (either the
 * shared pool or a client already inside a transaction, e.g. from
 * createStyle/updateStyle) so it can participate in the caller's
 * transaction instead of always opening its own.
 */
async function setStyleTags(queryable, styleId, tagIds = []) {
  await queryable.query(`DELETE FROM style_tags WHERE style_id = $1`, [styleId]);

  if (tagIds.length > 0) {
    const valuesSql = tagIds.map((_, i) => `($1, $${i + 2})`).join(", ");
    await queryable.query(
      `INSERT INTO style_tags (style_id, tag_id) VALUES ${valuesSql} ON CONFLICT DO NOTHING`,
      [styleId, ...tagIds]
    );
  }
}

/**
 * Used by backfillTags.js: applies a fresh auto-tag classification result to
 * a style and marks it as auto-assigned, in one transaction. Reuses
 * setStyleTags (the same tag-write path createStyle/updateStyle use) rather
 * than duplicating the delete+insert logic.
 */
async function setStyleTagsAutoAssigned(styleId, tagIds) {
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    await setStyleTags(client, styleId, tagIds);
    await client.query(
      `UPDATE styles SET tags_auto_assigned = true, updated_at = NOW() WHERE id = $1`,
      [styleId]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function createStyle(style) {
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");

    const result = await client.query(
      `
      INSERT INTO styles (
        category_id,
        name,
        prompt,
        negative_prompt,
        cover_image,
        credit_cost,
        is_trending,
        is_premium,
        is_enabled,
        sort_order,
        tags_auto_assigned
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9,
        COALESCE($10, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM styles WHERE category_id = $1)),
        $11
      )
      RETURNING id
      `,
      [
        style.categoryId,
        style.name,
        style.prompt,
        style.negativePrompt,
        style.coverImage,
        style.creditCost ?? 1,
        style.isTrending,
        style.isPremium,
        style.isEnabled,
        style.sortOrder ?? null,
        style.tagsAutoAssigned ?? true
      ]
    );

    const styleId = result.rows[0].id;
    await setStyleTags(client, styleId, style.tagIds ?? []);
    if (style.fields !== undefined) {
      await styleFieldsModel.replaceFields(client, styleId, style.fields);
    }

    await client.query("COMMIT");

    return getStyleById(styleId);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function updateStyle(id, style) {
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");

    const result = await client.query(
      `
      UPDATE styles
      SET
        category_id = $1,
        name = $2,
        prompt = $3,
        negative_prompt = $4,
        cover_image = $5,
        credit_cost = $6,
        is_trending = $7,
        is_premium = $8,
        is_enabled = $9,
        sort_order = $10,
        tags_auto_assigned = COALESCE($11, tags_auto_assigned),
        updated_at = NOW()
      WHERE id = $12
      RETURNING id
      `,
      [
        style.categoryId,
        style.name,
        style.prompt,
        style.negativePrompt,
        style.coverImage,
        style.creditCost ?? 1,
        style.isTrending,
        style.isPremium,
        style.isEnabled,
        style.sortOrder,
        style.tagsAutoAssigned ?? null,
        id
      ]
    );

    if (result.rows.length === 0) {
      await client.query("ROLLBACK");
      return undefined;
    }

    if (style.tagIds !== undefined) {
      await setStyleTags(client, id, style.tagIds);
    }
    if (style.fields !== undefined) {
      await styleFieldsModel.replaceFields(client, id, style.fields);
    }

    await client.query("COMMIT");

    return getStyleById(id);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Partial flag update for the Admin Dashboard's quick toggle actions
 * (Trending / Enable-Disable). Only the flags actually provided are
 * written - name/prompt/tags/sort order and every other column are left
 * untouched, unlike updateStyle's full-replace semantics.
 */
async function updateStyleFlags(id, flags = {}) {
  const sets = [];
  const params = [];

  if (flags.isTrending !== undefined) {
    params.push(flags.isTrending);
    sets.push(`is_trending = $${params.length}`);
  }

  if (flags.isEnabled !== undefined) {
    params.push(flags.isEnabled);
    sets.push(`is_enabled = $${params.length}`);
  }

  if (sets.length === 0) {
    return getStyleById(id);
  }

  params.push(id);
  const result = await db.query(
    `
    UPDATE styles
    SET ${sets.join(", ")},
        updated_at = NOW()
    WHERE id = $${params.length}
    RETURNING id
    `,
    params
  );

  if (result.rows.length === 0) {
    return undefined;
  }

  return getStyleById(id);
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
  getPublicStyles,
  getPublicStylesByIds,
  getStyleById,
  getEnabledStylesWithTags,
  getStylesNeedingAutoTag,
  setStyleTags,
  setStyleTagsAutoAssigned,
  createStyle,
  updateStyle,
  updateStyleFlags,
  deleteStyle,
  reorderStyles,
};
