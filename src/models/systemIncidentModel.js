const db = require("../config/db");
const { sanitizePayload } = require("./adminAuditModel");

/**
 * System Health module — persisted history for providerErrorLog.js's
 * image-generation-provider failures (see migration_system_health.sql for
 * why only 'image_provider' today, not a wider incident vocabulary).
 *
 * Mirrors securityEventModel.js's shape deliberately: same sanitize-before-
 * write discipline (reusing adminAuditModel's redaction, nothing new to
 * audit), same "record never throws into its caller" contract, and the same
 * NODE_ENV=test persistence gate for the same reason - logProviderError runs
 * from deep inside generation controllers/services across many pre-existing
 * tests that don't mock this model or config/db.
 */

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function asUuidOrNull(value) {
  return typeof value === "string" && UUID_RE.test(value) ? value : null;
}

/**
 * Off under NODE_ENV=test by default, same precedent and reasoning as
 * securityEventModel.js and abusePolicy.js's sweepEnabled.
 * SYSTEM_INCIDENTS_PERSIST_IN_TEST=true is the deliberate opt-out, used only
 * by this model's own test.
 */
const PERSIST_ENABLED =
  process.env.NODE_ENV !== "test" || process.env.SYSTEM_INCIDENTS_PERSIST_IN_TEST === "true";

const INSERT_SQL = `
  INSERT INTO system_incidents
    (source, severity, provider, phase, kind, message, status_code, request_id, user_id, endpoint, detail)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
  RETURNING id
`;

/**
 * Records one incident on its own connection. Fire-and-forget by contract:
 * callers invoke this without awaiting it, so a rejected promise here must
 * never surface as an unhandled rejection.
 */
async function record(entry) {
  if (!PERSIST_ENABLED) return;
  try {
    const detail = sanitizePayload(entry.detail);
    await db.query(INSERT_SQL, [
      entry.source,
      entry.severity || "error",
      entry.provider ?? null,
      entry.phase ?? null,
      entry.kind ?? null,
      entry.message ?? null,
      Number.isFinite(entry.statusCode) ? entry.statusCode : null,
      entry.requestId ?? null,
      asUuidOrNull(entry.userId),
      entry.endpoint ?? null,
      detail === null ? null : JSON.stringify(detail),
    ]);
  } catch (err) {
    console.error("[system_incidents] failed to record incident:", err && err.message);
  }
}

const LIST_COLUMNS = `
  id, source, severity, provider, phase, kind, message,
  status_code AS "statusCode", request_id AS "requestId", user_id AS "userId",
  endpoint, detail, created_at AS "createdAt"
`;

function buildFilters({ source, severity, q, from, to }) {
  const where = [];
  const params = [];

  if (source && source !== "all") {
    params.push(source);
    where.push(`source = $${params.length}`);
  }
  if (severity && severity !== "all") {
    params.push(severity);
    where.push(`severity = $${params.length}`);
  }
  if (q && String(q).trim()) {
    params.push(`%${String(q).trim().toLowerCase()}%`);
    where.push(
      `(LOWER(COALESCE(message, '')) LIKE $${params.length} OR LOWER(COALESCE(provider, '')) LIKE $${params.length} ` +
        `OR LOWER(COALESCE(kind, '')) LIKE $${params.length} OR LOWER(COALESCE(endpoint, '')) LIKE $${params.length})`
    );
  }
  if (from) {
    params.push(from);
    where.push(`created_at >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    where.push(`created_at <= $${params.length}`);
  }

  return { whereSql: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
}

/** list({limit, offset, source, severity, q, from, to}) -> {rows, total} */
async function list({ limit, offset, source, severity, q, from, to } = {}) {
  const { whereSql, params } = buildFilters({ source, severity, q, from, to });

  const rows = await db.query(
    `SELECT ${LIST_COLUMNS}
       FROM system_incidents
       ${whereSql}
      ORDER BY created_at DESC, id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );

  const countRes = await db.query(`SELECT COUNT(*)::int AS total FROM system_incidents ${whereSql}`, params);

  return { rows: rows.rows, total: countRes.rows[0]?.total ?? 0 };
}

module.exports = { record, list };
