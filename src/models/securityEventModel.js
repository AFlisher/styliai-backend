const db = require("../config/db");
const { sanitizePayload } = require("./adminAuditModel");

/**
 * Operations Center — persisted history for securityEvents.js's
 * auth_failure/authz_failure categories (see migration_security_events.sql
 * for why only these two, not the whole vocabulary).
 *
 * Mirrors adminAuditModel.js's shape deliberately: same sanitize-before-write
 * discipline, same "record never throws into its caller" contract - this
 * model is called from logAuthFailure/logAuthzFailure, which run on every
 * failed login and permission check across the whole app and must never be
 * the reason a request fails.
 */

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function asUuidOrNull(value) {
  return typeof value === "string" && UUID_RE.test(value) ? value : null;
}

/**
 * Off under NODE_ENV=test by default, same reasoning and precedent as
 * abusePolicy.js's sweepEnabled: logAuthFailure/logAuthzFailure are called,
 * unmocked, from deep inside authMiddleware/requireAdminRole on essentially
 * every negative-path test in the suite - none of those tests mock this
 * model or config/db, because until now securityEvents.js never touched the
 * database. Persisting there by default would mean every one of those tests
 * silently attempts a real Postgres connection using whatever DATABASE_URL
 * happens to be in the environment, which in local dev is the real one.
 * SECURITY_EVENTS_PERSIST_IN_TEST=true is the deliberate opt-out, used only
 * by this model's own test.
 */
const PERSIST_ENABLED =
  process.env.NODE_ENV !== "test" || process.env.SECURITY_EVENTS_PERSIST_IN_TEST === "true";

const INSERT_SQL = `
  INSERT INTO security_events
    (event_type, reason, subject, method, endpoint, ip, user_id, admin_id, request_id, detail)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
  RETURNING id
`;

/**
 * Records one security event on its own connection. Fire-and-forget by
 * contract: callers (securityEvents.js) invoke this without awaiting it, so
 * a rejected promise here must never surface as an unhandled rejection. The
 * try/catch is defense in depth around that contract, not a substitute for
 * the caller's own .catch().
 */
async function record(entry) {
  if (!PERSIST_ENABLED) return;
  try {
    const detail = sanitizePayload(entry.detail);
    await db.query(INSERT_SQL, [
      entry.eventType,
      entry.reason ?? null,
      entry.subject !== undefined && entry.subject !== null ? String(entry.subject) : null,
      entry.method ?? null,
      entry.endpoint ?? null,
      entry.ip ?? null,
      asUuidOrNull(entry.userId),
      asUuidOrNull(entry.adminId),
      entry.requestId ?? null,
      detail === null ? null : JSON.stringify(detail),
    ]);
  } catch (err) {
    console.error("[security_events] failed to record event:", err && err.message);
  }
}

const LIST_COLUMNS = `
  id, event_type AS "eventType", reason, subject, method, endpoint, ip,
  user_id AS "userId", admin_id AS "adminId", request_id AS "requestId",
  detail, created_at AS "createdAt"
`;

function buildFilters({ eventType, q, from, to }) {
  const where = [];
  const params = [];

  if (eventType && eventType !== "all") {
    params.push(eventType);
    where.push(`event_type = $${params.length}`);
  }
  if (q && q.trim()) {
    params.push(`%${q.trim().toLowerCase()}%`);
    where.push(
      `(LOWER(reason) LIKE $${params.length} OR LOWER(COALESCE(subject, '')) LIKE $${params.length} ` +
        `OR LOWER(COALESCE(endpoint, '')) LIKE $${params.length} OR LOWER(COALESCE(ip, '')) LIKE $${params.length})`
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

/** list({limit, offset, eventType, q, from, to}) -> {rows, total} */
async function list({ limit, offset, eventType, q, from, to } = {}) {
  const { whereSql, params } = buildFilters({ eventType, q, from, to });

  const rows = await db.query(
    `SELECT ${LIST_COLUMNS}
       FROM security_events
       ${whereSql}
      ORDER BY created_at DESC, id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );

  const countRes = await db.query(`SELECT COUNT(*)::int AS total FROM security_events ${whereSql}`, params);

  return { rows: rows.rows, total: countRes.rows[0]?.total ?? 0 };
}

module.exports = { record, list };
