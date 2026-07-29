const db = require("../config/db");
const { config } = require("../config/playIntegrityConfig");

/**
 * SEC-0.2 — the decrypt-once boundary.
 *
 * Postgres is authoritative here, not the in-process cache in verifyIntegrity.
 * That distinction matters: the promise cache collapses concurrent callers
 * inside one Node process, but two processes (or one process across a restart)
 * only agree because of the ON CONFLICT claim below. If this ever degrades to
 * best-effort, tokens get decoded twice, Google clears the verdicts, and the
 * symptom is intermittent integrity failures that look like an attack.
 *
 * The raw token never reaches this module — callers pass its SHA-256.
 */

/**
 * Attempts to claim the right to decode `tokenSha256`.
 *
 * Returns { claimed: true } for the winner, { claimed: false } for everyone
 * else. The insert IS the lock: it is a single atomic statement, so there is no
 * read-then-write window for two callers to race through (contrast
 * concurrentGenerationLimiter, which relies on Node's synchronous execution -
 * a guarantee that evaporates the moment an await appears, as it does here).
 *
 * Stale-claim recovery: a row still 'decoding' long after the decode could
 * possibly have finished belongs to a process that died mid-flight. Without
 * this, one crash would poison that token forever and the user's retry would
 * never resolve. The re-claim is itself conditional in SQL, so two recoverers
 * cannot both win.
 */
async function claim(tokenSha256, { requestHash, endpoint, userId }) {
  const inserted = await db.query(
    `INSERT INTO integrity_verdicts (token_sha256, status, request_hash, endpoint, user_id)
     VALUES ($1, 'decoding', $2, $3, $4)
     ON CONFLICT (token_sha256) DO NOTHING
     RETURNING token_sha256`,
    [tokenSha256, requestHash, endpoint, userId || null]
  );

  if (inserted.rowCount === 1) {
    return { claimed: true, recovered: false };
  }

  // Allow a generous multiple of the decode timeout before assuming the
  // claimant is dead - re-claiming a live decode would cause the very double
  // decode this table exists to prevent.
  const staleAfterMs = config.decodeTimeoutMs * 4;
  const recovered = await db.query(
    `UPDATE integrity_verdicts
        SET claimed_at = now(), request_hash = $2, endpoint = $3, user_id = $4
      WHERE token_sha256 = $1
        AND status = 'decoding'
        AND claimed_at < now() - ($5::bigint * INTERVAL '1 millisecond')
      RETURNING token_sha256`,
    [tokenSha256, requestHash, endpoint, userId || null, staleAfterMs]
  );

  return { claimed: recovered.rowCount === 1, recovered: recovered.rowCount === 1 };
}

/** Records the result of the one decode. Never stores the raw token. */
async function complete(tokenSha256, { verdict, outcome }) {
  await db.query(
    `UPDATE integrity_verdicts
        SET status = 'done', verdict = $2, outcome = $3, decoded_at = now()
      WHERE token_sha256 = $1`,
    [tokenSha256, verdict ? JSON.stringify(verdict) : null, outcome]
  );
}

/**
 * Reads an existing row. Returns null if absent.
 *
 * `verdictUsable` is the reuse decision: a stored verdict may only be replayed
 * to a caller while it is inside the (short) verdict TTL. Past that the row
 * still exists - as a replay ledger entry - but its verdict is no longer a
 * valid answer for a new request.
 */
async function get(tokenSha256) {
  const { rows } = await db.query(
    `SELECT token_sha256, status, verdict, outcome, request_hash, endpoint,
            user_id, claimed_at, decoded_at,
            (decoded_at IS NOT NULL
             AND decoded_at > now() - ($2::bigint * INTERVAL '1 millisecond')) AS verdict_usable
       FROM integrity_verdicts
      WHERE token_sha256 = $1`,
    [tokenSha256, config.verdictTtlMs]
  );
  return rows[0] || null;
}

/**
 * Two-stage retention, run by whatever schedules it (there is no scheduler in
 * this codebase yet - see SEC-20.x - so today this is called opportunistically
 * and is safe to call often).
 *
 * Stage 1 drops the verdict payload but keeps the row: device and Play-account
 * attestation data has no reason to sit in the database for a day, but the
 * fact that this token was seen does.
 * Stage 2 removes the row entirely once it can no longer tell us anything.
 */
async function evict() {
  const dropped = await db.query(
    `UPDATE integrity_verdicts
        SET verdict = NULL
      WHERE verdict IS NOT NULL
        AND decoded_at IS NOT NULL
        AND decoded_at < now() - ($1::bigint * INTERVAL '1 millisecond')`,
    [config.verdictTtlMs]
  );

  const deleted = await db.query(
    `DELETE FROM integrity_verdicts
      WHERE claimed_at < now() - ($1::bigint * INTERVAL '1 millisecond')`,
    [config.ledgerTtlMs]
  );

  return { verdictsDropped: dropped.rowCount, rowsDeleted: deleted.rowCount };
}

module.exports = { claim, complete, get, evict };
