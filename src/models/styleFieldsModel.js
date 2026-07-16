const db = require("../config/db");
const { assertUniqueKeys, normalizeOptions } = require("../utils/promptTemplate");

/** Maps a DB row to the API/DTO field shape consumed by the app + dashboard. */
function mapRow(r) {
  return {
    id: r.id,
    key: r.field_key,
    label: r.label,
    type: r.type,
    required: r.required,
    placeholder: r.placeholder ?? null,
    options: r.options ?? null,
    config: r.config ?? {},
    sortOrder: r.sort_order,
  };
}

/** Fields for one style, ordered for form rendering. */
async function getFieldsForStyle(styleId, queryable = db) {
  const res = await queryable.query(
    `SELECT * FROM style_fields WHERE style_id = $1 ORDER BY sort_order ASC, created_at ASC`,
    [styleId]
  );
  return res.rows.map(mapRow);
}

/**
 * Fields for many styles in one round-trip, returned as a Map<styleId, field[]>
 * so list endpoints avoid an N+1.
 */
async function getFieldsForStyleIds(styleIds, queryable = db) {
  const map = new Map();
  if (!styleIds || styleIds.length === 0) return map;
  const res = await queryable.query(
    `SELECT * FROM style_fields WHERE style_id = ANY($1) ORDER BY sort_order ASC, created_at ASC`,
    [styleIds]
  );
  for (const row of res.rows) {
    const f = mapRow(row);
    if (!map.has(row.style_id)) map.set(row.style_id, []);
    map.get(row.style_id).push(f);
  }
  return map;
}

/**
 * Replaces the entire field set for a style inside the caller's transaction.
 * Validates definitions and rejects duplicate keys before writing. Passing an
 * empty array clears all fields (reverting the style to a plain prompt).
 */
async function replaceFields(client, styleId, fields = []) {
  const list = Array.isArray(fields) ? fields : [];
  assertUniqueKeys(list); // throws PromptValidationError on invalid/dup keys

  await client.query(`DELETE FROM style_fields WHERE style_id = $1`, [styleId]);

  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    const key = f.key ?? f.field_key;
    const options = f.type === "dropdown" ? normalizeOptions(f.options) : (f.options ?? null);
    await client.query(
      `INSERT INTO style_fields
         (style_id, field_key, label, type, required, placeholder, options, config, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        styleId,
        key,
        f.label,
        f.type || "text",
        Boolean(f.required),
        f.placeholder ?? null,
        options ? JSON.stringify(options) : null,
        JSON.stringify(f.config && typeof f.config === "object" ? f.config : {}),
        f.sortOrder ?? i,
      ]
    );
  }
}

module.exports = {
  mapRow,
  getFieldsForStyle,
  getFieldsForStyleIds,
  replaceFields,
};
