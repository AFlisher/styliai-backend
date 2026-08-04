const db = require("../config/db");

/**
 * SEC-18.1 - persistence for detector findings and per-account risk scores.
 *
 * Findings are UPSERTED on (detector, subject, window). A detector that runs
 * opportunistically - which these do, since there is no scheduler (SEC-20.x) -
 * will re-evaluate the same window many times, and without the upsert each
 * sweep would add a duplicate row. The unique index in the migration is what
 * enforces this; the ON CONFLICT here is what makes re-running cheap and safe.
 */

/**
 * Records or refreshes a finding.
 *
 * `action` is deliberately NOT overwritten on conflict when the existing row
 * already recorded an enforcement action. If a sweep suspended an account at
 * 10:00 and a later sweep over the same window re-evaluates it, the record must
 * still say "suspended" - losing that would erase the only durable statement of
 * what the system did and why, which is exactly what an operator needs when
 * deciding whether to reinstate.
 */
async function record({
  userId = null,
  detector,
  severity = "low",
  evidence = {},
  originHash = null,
  action = "flagged",
  windowStart,
  windowEnd,
}, client = db) {
  const result = await client.query(
    `INSERT INTO abuse_findings
       (user_id, detector, severity, evidence, origin_hash, action, window_start, window_end)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
     ON CONFLICT (detector, COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(origin_hash, ''), window_start)
     DO UPDATE SET
       severity   = EXCLUDED.severity,
       evidence   = EXCLUDED.evidence,
       window_end = EXCLUDED.window_end,
       -- Never downgrade a recorded enforcement action back to 'flagged'.
       action     = CASE WHEN abuse_findings.action = 'suspended'
                         THEN abuse_findings.action
                         ELSE EXCLUDED.action END
     RETURNING id, detector, severity, action, user_id AS "userId", origin_hash AS "originHash"`,
    [
      userId,
      detector,
      severity,
      JSON.stringify(evidence),
      originHash,
      action,
      windowStart,
      windowEnd,
    ]
  );
  return result.rows[0];
}

/** Marks a finding's action after enforcement acted on it. */
async function setAction(id, action, client = db) {
  const result = await client.query(
    `UPDATE abuse_findings SET action = $2 WHERE id = $1 RETURNING id, action`,
    [id, action]
  );
  return result.rows[0] || null;
}

/**
 * The admin review queue. Bounded, newest first, unreviewed by default.
 *
 * SEC-19.2's discipline applies here too: this is a list endpoint, so it has a
 * server-enforced ceiling rather than relying on the caller to ask for a sane
 * number.
 */
async function list({ limit = 50, includeReviewed = false, userId = null } = {}) {
  const safeLimit = Math.min(Math.max(1, Math.floor(limit) || 50), 200);
  const params = [safeLimit];
  const where = [];

  if (!includeReviewed) where.push("reviewed_at IS NULL");
  if (userId) {
    params.push(userId);
    where.push(`user_id = $${params.length}`);
  }

  const result = await db.query(
    `SELECT id,
            user_id AS "userId",
            detector,
            severity,
            evidence,
            origin_hash AS "originHash",
            action,
            reviewed_at AS "reviewedAt",
            review_outcome AS "reviewOutcome",
            window_start AS "windowStart",
            window_end AS "windowEnd",
            created_at AS "createdAt"
       FROM abuse_findings
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY created_at DESC
      LIMIT $1`,
    params
  );
  return result.rows;
}

/**
 * Records a human's verdict on a finding.
 *
 * `false_positive` is a first-class outcome rather than a deletion: a detector
 * that keeps producing them needs its threshold changed, and that argument can
 * only be made from a record of the ones that were wrong.
 */
async function review({ id, adminId, outcome }, client = db) {
  const result = await client.query(
    `UPDATE abuse_findings
        SET reviewed_at = now(), reviewed_by = $2, review_outcome = $3
      WHERE id = $1
      RETURNING id, review_outcome AS "reviewOutcome", user_id AS "userId", detector`,
    [id, adminId, outcome]
  );
  return result.rows[0] || null;
}

/** Upserts a per-account risk score. */
async function upsertRiskScore({ userId, score, factors }, client = db) {
  const result = await client.query(
    `INSERT INTO user_risk_scores (user_id, score, factors, computed_at)
     VALUES ($1, $2, $3::jsonb, now())
     ON CONFLICT (user_id) DO UPDATE
       SET score = EXCLUDED.score,
           factors = EXCLUDED.factors,
           computed_at = now()
     RETURNING user_id AS "userId", score`,
    [userId, score, JSON.stringify(factors || {})]
  );
  return result.rows[0];
}

/** Top-N riskiest accounts, for the dashboard. Bounded. */
async function topRisk({ limit = 25 } = {}) {
  const safeLimit = Math.min(Math.max(1, Math.floor(limit) || 25), 100);
  const result = await db.query(
    `SELECT r.user_id AS "userId",
            r.score,
            r.factors,
            r.computed_at AS "computedAt",
            u.email,
            u.status,
            u.created_at AS "accountCreatedAt",
            u.country_code AS "countryCode"
       FROM user_risk_scores r
       JOIN public.users u ON u.id = r.user_id
      WHERE r.score > 0
      ORDER BY r.score DESC, r.computed_at DESC
      LIMIT $1`,
    [safeLimit]
  );
  return result.rows;
}

module.exports = { record, setAction, list, review, upsertRiskScore, topRisk };
