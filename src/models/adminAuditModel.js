const db = require("../config/db");

/**
 * SEC-15.1: append-only accountability trail for privileged admin actions.
 *
 * Narrow by design, in the same spirit as generationEventsModel: identity,
 * what was done, to what, from where, and the minimum state needed to
 * reconstruct a destructive action. Never the admin's token, never a password.
 *
 * Append-only is enforced by the absence of any update/delete path in this
 * module, NOT by database grants - the backend connects as the table owner, so
 * anyone holding the connection string could still rewrite history. Genuine
 * tamper-evidence needs off-box log shipping and is out of scope here.
 */

// Keys whose values are never written to the audit log, matched as a substring
// of the key name (case-insensitive) at every depth. No current admin route
// submits any of these - the filter exists so that a route added later cannot
// quietly start persisting a credential, rather than because one does today.
// `totp` and `recovery` were added with SEC-15.2, which introduced two new
// credential-shaped request fields (totpCode, recoveryCode). A TOTP code is
// single-use and expires in ~90s, but a recovery code is a long-lived
// password-equivalent bearer credential and must never be persisted here.
const SENSITIVE_KEY_PATTERN =
  /pass|token|secret|authorization|api[-_]?key|credential|totp|recovery/i;

// Serialized-JSON byte ceiling per column. Style prompts are unbounded free
// text and an admin could submit a megabyte of them; an accountability record
// must not become an unbounded write amplifier. 8 KB keeps every realistic
// payload intact - the largest real one (a style with prompt, negative prompt
// and field definitions) is well under 2 KB.
const MAX_PAYLOAD_BYTES = 8 * 1024;
const TRUNCATED_PREVIEW_CHARS = 2000;

/**
 * Returns a copy of `value` with credential-shaped keys removed and the whole
 * thing bounded in size. Must never throw: it runs on the response path of
 * every admin mutation, and its caller cannot usefully handle a failure.
 *
 * @param {*} value
 * @returns {*} JSON-serializable, or null when there is nothing to record.
 */
function sanitizePayload(value) {
  if (value === undefined || value === null) {
    return null;
  }

  try {
    const stripped = stripSensitive(value, 0);

    const serialized = JSON.stringify(stripped);
    if (serialized === undefined) {
      // Not JSON-serializable at all (e.g. a bare function or symbol).
      return null;
    }

    if (Buffer.byteLength(serialized, "utf8") <= MAX_PAYLOAD_BYTES) {
      return stripped;
    }

    // Keep a bounded head of the payload rather than dropping it entirely:
    // enough to tell what the action was, explicitly marked so nobody reads a
    // truncated record as a complete one.
    return {
      _truncated: true,
      _originalBytes: Buffer.byteLength(serialized, "utf8"),
      _preview: serialized.slice(0, TRUNCATED_PREVIEW_CHARS),
    };
  } catch (err) {
    // Circular structure, a throwing getter, a throwing toJSON - record the
    // failure rather than losing the fact that the action happened.
    return { _unserializable: true };
  }
}

// Depth-bounded so a deeply nested or self-referential payload cannot blow the
// stack before JSON.stringify gets a chance to reject it.
const MAX_DEPTH = 8;

function stripSensitive(value, depth) {
  if (depth > MAX_DEPTH) {
    return "[MAX_DEPTH]";
  }
  // Summarized before serialization, not after: JSON.stringify turns a Buffer
  // into a {"type":"Buffer","data":[...]} array roughly 5x its byte length, so
  // a 10 MB upload would build a ~50 MB string in memory before the size cap
  // below ever got to reject it. multer keeps uploads on req.file rather than
  // req.body so nothing hits this today - it's here so nothing has to.
  if (Buffer.isBuffer(value)) {
    return { _buffer: true, _bytes: value.length };
  }
  if (Array.isArray(value)) {
    return value.map((item) => stripSensitive(item, depth + 1));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  const out = {};
  for (const key of Object.keys(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      out[key] = "[REDACTED]";
      continue;
    }
    out[key] = stripSensitive(value[key], depth + 1);
  }
  return out;
}

const INSERT_SQL = `
  INSERT INTO admin_audit_log
    (admin_id, admin_email, action, target_type, target_id,
     before, after, ip, request_url, status_code)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
  RETURNING id
`;

function toValues(entry) {
  const before = sanitizePayload(entry.before);
  const after = sanitizePayload(entry.after);

  return [
    entry.adminId,
    entry.adminEmail ?? null,
    entry.action,
    entry.targetType ?? null,
    entry.targetId ?? null,
    before === null ? null : JSON.stringify(before),
    after === null ? null : JSON.stringify(after),
    entry.ip ?? null,
    entry.requestUrl ?? null,
    entry.statusCode ?? null,
  ];
}

/**
 * Records one audit entry on its own connection.
 *
 * Used by the fail-open path (catalog / pricing / uploads): the mutation has
 * already committed by the time this runs, so a failure here must not undo or
 * fail the request. Callers are responsible for catching.
 */
async function record(entry) {
  const result = await db.query(INSERT_SQL, toValues(entry));
  return result.rows[0];
}

/**
 * Records one audit entry on a caller-supplied client, inside the caller's
 * open transaction.
 *
 * Used by the fail-closed money path: if this insert fails, the balance change
 * rolls back with it, so credits can never move without an attributable record.
 */
async function recordWithClient(client, entry) {
  const result = await client.query(INSERT_SQL, toValues(entry));
  return result.rows[0];
}

const LIST_COLUMNS = `
  id, admin_id AS "adminId", admin_email AS "adminEmail", action,
  target_type AS "targetType", target_id AS "targetId", before, after,
  ip, request_url AS "requestUrl", status_code AS "statusCode",
  created_at AS "createdAt"
`;

/**
 * Builds the shared WHERE clause for list()/count() so the two can never see
 * a different row set - the classic bug where a filter is added to one query
 * and forgotten in the other, producing a page count that doesn't match what
 * was paged through.
 */
function buildFilters({ action, targetType, adminId, q, from, to }) {
  const where = [];
  const params = [];

  // `action` accepts a single value or a comma-separated list, so one
  // endpoint serves both "everything" and "just suspend + reinstate" (the
  // Operations Center's per-category tabs) without a second query shape.
  if (action) {
    const actions = String(action)
      .split(",")
      .map((a) => a.trim())
      .filter(Boolean);
    if (actions.length) {
      params.push(actions);
      where.push(`action = ANY($${params.length}::text[])`);
    }
  }
  if (targetType) {
    params.push(targetType);
    where.push(`target_type = $${params.length}`);
  }
  if (adminId) {
    params.push(adminId);
    where.push(`admin_id = $${params.length}`);
  }
  if (q && String(q).trim()) {
    params.push(`%${String(q).trim().toLowerCase()}%`);
    where.push(
      `(LOWER(action) LIKE $${params.length} OR LOWER(COALESCE(target_id, '')) LIKE $${params.length} ` +
        `OR LOWER(COALESCE(admin_email, '')) LIKE $${params.length} OR LOWER(COALESCE(target_type, '')) LIKE $${params.length})`
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

/**
 * The Operations Center's read side of this table (SEC-15.1's write side is
 * above). Offset-paginated to match listUsers' precedent rather than the
 * keyset cursor pagination.js also offers - this is an operator scrolling a
 * few pages deep on a filtered view, not an unbounded feed.
 *
 * list({limit, offset, action, targetType, adminId, q, from, to}) -> {rows, total}
 */
async function list({ limit, offset, action, targetType, adminId, q, from, to } = {}) {
  const { whereSql, params } = buildFilters({ action, targetType, adminId, q, from, to });

  const rows = await db.query(
    `SELECT ${LIST_COLUMNS}
       FROM admin_audit_log
       ${whereSql}
      ORDER BY created_at DESC, id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );

  const countRes = await db.query(`SELECT COUNT(*)::int AS total FROM admin_audit_log ${whereSql}`, params);

  return { rows: rows.rows, total: countRes.rows[0]?.total ?? 0 };
}

module.exports = {
  record,
  recordWithClient,
  list,
  sanitizePayload,
  MAX_PAYLOAD_BYTES,
};
