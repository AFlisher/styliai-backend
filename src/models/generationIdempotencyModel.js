const db = require("../config/db");
const { envInt } = require("../utils/pagination");

/**
 * SEC-3.1 - storage for generation idempotency claims.
 *
 * The claim is made by the DATABASE, not by application logic: an
 * `INSERT ... ON CONFLICT DO NOTHING` either inserts a row or does not, and
 * `rowCount` says which. Two concurrent requests carrying the same key can
 * therefore never both proceed, no matter how they interleave, because the
 * primary key is the arbiter. A read-then-write ("does a row exist? no? then
 * insert") would have a window between the two statements wide enough for
 * exactly the duplicate this finding is about.
 */

const TTL_HOURS = envInt("IDEMPOTENCY_TTL_HOURS", 24);

/**
 * Attempts to claim a key. Returns `{ claimed: true }` when this caller won
 * and may proceed, or `{ claimed: false, existing }` with the row that already
 * holds it.
 *
 * Expired rows are not treated as blocking: the `WHERE` on the DO UPDATE lets
 * a claim older than the TTL be taken over rather than blocking a legitimate
 * new request forever with a key the client happens to reuse days later.
 */
async function claim({ userId, key, endpoint, fingerprint }) {
  const result = await db.query(
    `
    INSERT INTO generation_idempotency
      (user_id, idempotency_key, endpoint, request_fingerprint, status)
    VALUES ($1, $2, $3, $4, 'in_progress')
    ON CONFLICT (user_id, idempotency_key) DO UPDATE
      SET endpoint            = EXCLUDED.endpoint,
          request_fingerprint = EXCLUDED.request_fingerprint,
          status              = 'in_progress',
          response_body       = NULL,
          response_status     = NULL,
          created_at          = now(),
          completed_at        = NULL
      -- Take over ONLY a row that has aged out. Without this predicate the
      -- DO UPDATE would overwrite a live claim, which would defeat the whole
      -- mechanism by letting a concurrent duplicate proceed.
      WHERE generation_idempotency.created_at < now() - ($5 || ' hours')::interval
    -- RETURNING exists so rowCount distinguishes the three cases. Verified
    -- against live Postgres: fresh insert -> 1, conflict with a LIVE claim
    -- (WHERE false, row skipped) -> 0, conflict with an EXPIRED claim -> 1.
    -- That 0 is what makes the claim exclusive.
    RETURNING 1
    `,
    [userId, key, endpoint, fingerprint, String(TTL_HOURS)]
  );

  // A conflict whose WHERE excluded the update returns zero rows: the existing
  // claim is live and this caller did not win.
  if (result.rowCount === 0) {
    const existing = await get({ userId, key });
    return { claimed: false, existing };
  }

  return { claimed: true };
}

async function get({ userId, key }) {
  const result = await db.query(
    `SELECT user_id AS "userId",
            idempotency_key AS "idempotencyKey",
            endpoint,
            request_fingerprint AS "requestFingerprint",
            status,
            response_body AS "responseBody",
            response_status AS "responseStatus",
            created_at AS "createdAt",
            completed_at AS "completedAt"
       FROM generation_idempotency
      WHERE user_id = $1 AND idempotency_key = $2`,
    [userId, key]
  );
  return result.rows[0] || null;
}

/** Records the successful response so a later retry replays it. */
async function complete({ userId, key, statusCode, body }) {
  await db.query(
    `UPDATE generation_idempotency
        SET status = 'completed',
            response_status = $3,
            response_body = $4,
            completed_at = now()
      WHERE user_id = $1 AND idempotency_key = $2`,
    [userId, key, statusCode, body === undefined ? null : JSON.stringify(body)]
  );
}

/**
 * Releases a claim.
 *
 * Called when the request FAILED. This is deliberate and is the difference
 * between an idempotency mechanism and a footgun: a generation that failed was
 * refunded, so the user has their credit back and must be able to retry - if
 * the key stayed claimed, their retry would be rejected as a duplicate of a
 * request that never produced anything, and the key they are holding would be
 * permanently poisoned.
 */
async function release({ userId, key }) {
  await db.query(
    `DELETE FROM generation_idempotency
      WHERE user_id = $1 AND idempotency_key = $2 AND status = 'in_progress'`,
    [userId, key]
  );
}

/**
 * Deletes claims past the replay window.
 *
 * Bounded by `limit` and driven off idx_generation_idempotency_created, so
 * this can never itself become a long-running statement - the failure mode
 * SEC-19.1 and SEC-19.3 are both about. Returns the number deleted so a caller
 * can decide whether to sweep again.
 */
async function purgeExpired({ limit = 1000 } = {}) {
  const result = await db.query(
    `DELETE FROM generation_idempotency
      WHERE ctid IN (
        SELECT ctid FROM generation_idempotency
         WHERE created_at < now() - ($1 || ' hours')::interval
         ORDER BY created_at
         LIMIT $2
      )`,
    [String(TTL_HOURS), limit]
  );
  return result.rowCount;
}

module.exports = { claim, get, complete, release, purgeExpired, TTL_HOURS };
