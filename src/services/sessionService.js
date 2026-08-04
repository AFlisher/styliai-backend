const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const db = require('../config/db');

/**
 * Phase 6 - server-side session state: token versioning, refresh-token
 * families, reuse detection, and account status.
 *
 * Everything that can end a session lives here so there is exactly ONE session
 * model. Before this, "revocation" was three unrelated `UPDATE users SET
 * refresh_token_hash = NULL` statements in three controllers, each of which
 * stopped the next refresh and none of which stopped an already-issued access
 * token.
 */

// Refresh token lifetime. SEC-1.4 recommends 7-14 days against the previous
// 30; 14 keeps a fortnight-idle user signed in while halving the window in
// which a stolen token is useful. Env-tunable because the right value is a
// product decision, not a security constant.
const REFRESH_TOKEN_TTL_DAYS = Number(process.env.REFRESH_TOKEN_TTL_DAYS) || 14;

// Statuses that may hold a session. Anything else is stopped by the middleware
// on the next request, not at next login.
const ACTIVE_STATUS = 'active';

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function refreshTokenExpiry() {
  return new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 3600 * 1000);
}

/**
 * The single read that makes revocation possible.
 *
 * Called by authMiddleware on every authenticated request: a primary-key
 * lookup returning two small columns. This is the cost of revocation - a
 * stateless JWT cannot be revoked by definition, so something has to consult
 * server state. It is deliberately NOT cached: a cache TTL is exactly the
 * window in which a suspended abuser keeps working, and with multiple Railway
 * instances a per-process cache would also make that window vary by whichever
 * instance served the request.
 */
async function getUserSessionState(userId) {
  const res = await db.query(
    'SELECT token_version, status FROM public.users WHERE id = $1',
    [userId]
  );
  return res.rows.length ? res.rows[0] : null;
}

async function getAdminSessionState(adminId) {
  const res = await db.query(
    'SELECT token_version FROM admins WHERE id = $1',
    [adminId]
  );
  return res.rows.length ? res.rows[0] : null;
}

/**
 * Invalidates every access token ever issued for this user, immediately.
 *
 * Access tokens carry the version they were minted at; bumping the column
 * makes every outstanding one mismatch on its next request. There is no
 * denylist to store, size or expire - the counter is the denylist.
 */
async function bumpUserTokenVersion(userId, client = db) {
  const res = await client.query(
    'UPDATE public.users SET token_version = token_version + 1 WHERE id = $1 RETURNING token_version',
    [userId]
  );
  return res.rows.length ? res.rows[0].token_version : null;
}

async function bumpAdminTokenVersion(adminId, client = db) {
  const res = await client.query(
    'UPDATE admins SET token_version = token_version + 1 WHERE id = $1 RETURNING token_version',
    [adminId]
  );
  return res.rows.length ? res.rows[0].token_version : null;
}

/**
 * Records a newly issued refresh token. `familyId` omitted starts a new family
 * (a fresh login); passing one continues an existing rotation chain.
 */
async function recordRefreshToken({ userId, token, familyId }, client = db) {
  const family = familyId || uuidv4();
  await client.query(
    `INSERT INTO refresh_tokens (token_hash, user_id, family_id, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [hashToken(token), userId, family, refreshTokenExpiry()]
  );
  return family;
}

/**
 * Revokes every refresh token the user holds, across all families and devices.
 *
 * Used by logout-all, password change, password reset and suspension. Rows are
 * marked rather than deleted so a later investigation can still see that a
 * family existed and why it ended.
 */
async function revokeAllUserRefreshTokens(userId, reason, client = db) {
  const res = await client.query(
    `UPDATE refresh_tokens
     SET revoked_at = now(), revoked_reason = $2
     WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId, reason]
  );
  return res.rowCount || 0;
}

async function revokeRefreshFamily(familyId, reason, client = db) {
  const res = await client.query(
    `UPDATE refresh_tokens
     SET revoked_at = now(), revoked_reason = $2
     WHERE family_id = $1 AND revoked_at IS NULL`,
    [familyId, reason]
  );
  return res.rowCount || 0;
}

/**
 * Atomically consumes a refresh token, or reports precisely why it could not.
 *
 * The consuming UPDATE is the whole design. Checking "is this token unused?"
 * with a SELECT and then marking it used with an UPDATE lets two concurrent
 * requests both pass the check - which is indistinguishable from the theft
 * this function exists to detect. A single conditional UPDATE means exactly
 * one caller can win, and the loser is correctly reported as a reuse.
 *
 * Returns one of:
 *   { outcome: 'consumed', userId, familyId }
 *   { outcome: 'reuse',    userId, familyId }  - caller MUST revoke the family
 *   { outcome: 'revoked' }
 *   { outcome: 'expired' }
 *   { outcome: 'unknown' }
 */
async function consumeRefreshToken(token, client = db) {
  const tokenHash = hashToken(token);

  const consumed = await client.query(
    `UPDATE refresh_tokens
     SET used_at = now()
     WHERE token_hash = $1
       AND used_at IS NULL
       AND revoked_at IS NULL
       AND expires_at > now()
     RETURNING user_id, family_id`,
    [tokenHash]
  );

  if (consumed.rows.length > 0) {
    return {
      outcome: 'consumed',
      userId: consumed.rows[0].user_id,
      familyId: consumed.rows[0].family_id,
    };
  }

  // The UPDATE matched nothing. Find out which of the four reasons applies -
  // they are not interchangeable: one of them is an active attack.
  const existing = await client.query(
    `SELECT user_id, family_id, used_at, revoked_at, (expires_at <= now()) AS is_expired
     FROM refresh_tokens WHERE token_hash = $1`,
    [tokenHash]
  );

  if (existing.rows.length === 0) {
    return { outcome: 'unknown' };
  }

  const row = existing.rows[0];

  // Order matters. A token that was used AND later revoked is still a reuse
  // report: the revocation may well have been triggered by the first reuse,
  // and treating the second presentation as a plain "revoked" would hide a
  // repeat attempt from the security log.
  if (row.used_at) {
    return { outcome: 'reuse', userId: row.user_id, familyId: row.family_id };
  }
  if (row.revoked_at) {
    return { outcome: 'revoked', userId: row.user_id, familyId: row.family_id };
  }
  if (row.is_expired) {
    return { outcome: 'expired', userId: row.user_id, familyId: row.family_id };
  }
  return { outcome: 'unknown' };
}

/**
 * Legacy bridge, removable after the last pre-Phase-6 refresh token expires
 * (30 days from deploy - see migration_session_revocation.sql §5).
 *
 * Sessions that predate this phase hold a token whose hash lives only in
 * users.refresh_token_hash. Without this fallback every logged-in user would
 * be signed out the moment Phase 6 deployed. Accepts such a token exactly
 * once, then clears the column so the same value cannot be replayed - the
 * session continues inside refresh_tokens from that point on.
 */
async function consumeLegacyRefreshToken(userId, token, client = db) {
  const res = await client.query(
    `UPDATE public.users
     SET refresh_token_hash = NULL
     WHERE id = $1 AND refresh_token_hash = $2
     RETURNING id`,
    [userId, hashToken(token)]
  );
  return res.rows.length > 0;
}

/**
 * Deletes refresh rows that can no longer authorise anything. Retention, not
 * security: expired and revoked rows are already refused by the consuming
 * UPDATE. Not scheduled automatically - run from an operator shell.
 */
async function purgeDeadRefreshTokens({ olderThanDays = 30 } = {}) {
  const res = await db.query(
    `DELETE FROM refresh_tokens
     WHERE expires_at < now() - ($1 || ' days')::interval
        OR (revoked_at IS NOT NULL AND revoked_at < now() - ($1 || ' days')::interval)`,
    [String(olderThanDays)]
  );
  return res.rowCount || 0;
}

module.exports = {
  ACTIVE_STATUS,
  REFRESH_TOKEN_TTL_DAYS,
  hashToken,
  refreshTokenExpiry,
  getUserSessionState,
  getAdminSessionState,
  bumpUserTokenVersion,
  bumpAdminTokenVersion,
  recordRefreshToken,
  revokeAllUserRefreshTokens,
  revokeRefreshFamily,
  consumeRefreshToken,
  consumeLegacyRefreshToken,
  purgeDeadRefreshTokens,
};
