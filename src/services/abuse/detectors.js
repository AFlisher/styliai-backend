const db = require("../../config/db");

/**
 * SEC-18.1 - the three detectors the audit asks for, plus SEC-18.5's session
 * signal.
 *
 * DESIGN CONSTRAINT, stated up front: "Build detection on the data you already
 * store - no new collection required." Every query below reads tables and
 * indexes that already existed (`wallet_transactions`, `daily_rewards`,
 * `generation_events`, `users`, and Phase 6's `refresh_tokens`). The only new
 * signal is SEC-18.3's origin hash, which the audit itself recommends and which
 * is a hash rather than a new class of personal data.
 *
 * WHY ORIGIN-KEYED RATHER THAN COUNTRY-KEYED. The audit's sharpest observation
 * in this section is that the country-level version of these signals is
 * indistinguishable from success: "many registrations from country X this hour"
 * is exactly what a good marketing day looks like. Keying on the origin hash is
 * what separates the two - a campaign produces many accounts from many origins,
 * a farm produces many from few. Every detector here that could have been
 * written against `country_code` is deliberately written against
 * `signup_origin_hash` instead.
 *
 * ALL QUERIES ARE BOUNDED. They run through `db.analyticsQuery` (SEC-19.3's
 * scoped longer statement timeout) because they are aggregates, and each
 * carries an explicit LIMIT so a sweep can never become SEC-19.1's failure
 * mode - a job whose cost grows with total lifetime usage.
 */

/**
 * Detector 1 - registration velocity per origin.
 *
 * Answers "how many accounts appeared from one origin in this window". This is
 * SEC-4.1's mechanism made visible: an attacker registering N accounts to
 * harvest one credit each per day has to create them from somewhere, and while
 * a rotating proxy pool defeats this, it also raises the attacker's cost, which
 * is the entire economic argument in Item 18.2.
 *
 * Accounts with a NULL origin hash are excluded, not grouped. Grouping every
 * unresolvable request together would manufacture a fake cluster of unrelated
 * users - a false-positive generator aimed at whoever has the most unusual
 * network setup.
 */
async function registrationVelocity({ windowStart, windowEnd, threshold, limit }) {
  const result = await db.analyticsQuery(
    `SELECT signup_origin_hash AS "originHash",
            COUNT(*)::int       AS "accountCount",
            MIN(created_at)     AS "firstSeen",
            MAX(created_at)     AS "lastSeen",
            COUNT(DISTINCT country_code)::int AS "countryCount",
            ARRAY_AGG(id ORDER BY created_at) AS "userIds"
       FROM public.users
      WHERE signup_origin_hash IS NOT NULL
        AND created_at >= $1
        AND created_at <  $2
      GROUP BY signup_origin_hash
     HAVING COUNT(*) >= $3
      ORDER BY COUNT(*) DESC
      LIMIT $4`,
    [windowStart, windowEnd, threshold, limit]
  );
  return result.rows;
}

/**
 * Detector 2 - generation velocity per user.
 *
 * "Is this account generating at machine speed." Reads `generation_events`,
 * which already carries a `user_id` index and `created_at`, exactly as the
 * audit's recommendation notes.
 *
 * Bounded above by real economics for a human: a generation costs a credit, a
 * credit costs two watched ads, and the daily reward is capped at one per
 * account per day. So a sustained high rate is not something a legitimate user
 * can reach by trying harder - it means either a compromised account burning a
 * balance, or a future promo being exploited.
 */
async function generationVelocity({ windowStart, windowEnd, threshold, limit }) {
  const result = await db.analyticsQuery(
    `SELECT ge.user_id            AS "userId",
            COUNT(*)::int         AS "generationCount",
            MIN(ge.created_at)    AS "firstSeen",
            MAX(ge.created_at)    AS "lastSeen",
            u.signup_origin_hash  AS "originHash"
       FROM generation_events ge
       JOIN public.users u ON u.id = ge.user_id
      WHERE ge.created_at >= $1
        AND ge.created_at <  $2
      GROUP BY ge.user_id, u.signup_origin_hash
     HAVING COUNT(*) >= $3
      ORDER BY COUNT(*) DESC
      LIMIT $4`,
    [windowStart, windowEnd, threshold, limit]
  );
  return result.rows;
}

/**
 * Detector 3a - reward grants per origin. THE farming detector.
 *
 * This is the one that country granularity could not provide, and it is worth
 * being precise about why it works. One credit per account per day is correct
 * *per account* - the daily-reward logic is airtight and §4/§5 verified it. But
 * twenty accounts behind one origin each claiming their one legitimate credit
 * is a farm, and every individual claim is indistinguishable from honest use.
 * The abuse is only visible in the aggregate, and only when the aggregate is
 * keyed on something that links the accounts.
 */
async function rewardFarmingByOrigin({ windowStart, windowEnd, threshold, limit }) {
  const result = await db.analyticsQuery(
    `SELECT u.signup_origin_hash        AS "originHash",
            COUNT(DISTINCT dr.user_id)::int AS "accountCount",
            COALESCE(SUM(dr.credits_claimed), 0)::int AS "creditsClaimed",
            MIN(dr.created_at)          AS "firstSeen",
            MAX(dr.created_at)          AS "lastSeen"
       FROM daily_rewards dr
       JOIN public.users u ON u.id = dr.user_id
      WHERE u.signup_origin_hash IS NOT NULL
        AND dr.created_at >= $1
        AND dr.created_at <  $2
      GROUP BY u.signup_origin_hash
     HAVING COUNT(DISTINCT dr.user_id) >= $3
      ORDER BY COUNT(DISTINCT dr.user_id) DESC
      LIMIT $4`,
    [windowStart, windowEnd, threshold, limit]
  );
  return result.rows;
}

/**
 * Detector 3b - admin balance adjustments.
 *
 * Admin adjustment is the one path that mints credits from nothing, so an
 * unusual burst is worth surfacing. This deliberately does NOT try to decide
 * whether an adjustment was legitimate - it cannot, and SEC-15.1's audit log
 * already records which admin performed each one. It reports the rate so a
 * human can go and look, which is the correct division of labour between a
 * detector and an operator.
 */
async function adminAdjustmentVolume({ windowStart, windowEnd, threshold }) {
  const result = await db.analyticsQuery(
    `SELECT COUNT(*)::int                       AS "adjustmentCount",
            COUNT(DISTINCT user_id)::int        AS "affectedUsers",
            COALESCE(SUM(GREATEST(amount, 0)), 0)::int AS "creditsGranted",
            MIN(created_at)                     AS "firstSeen",
            MAX(created_at)                     AS "lastSeen"
       FROM wallet_transactions
      WHERE type = 'admin'
        AND created_at >= $1
        AND created_at <  $2
     HAVING COUNT(*) >= $3`,
    [windowStart, windowEnd, threshold]
  );
  return result.rows[0] || null;
}

/**
 * Detector 4 (SEC-18.5) - concurrent session origins per account.
 *
 * The audit: "the single most reliable signal that an account has been stolen
 * is simultaneous use from two places, and that signal is neither computed nor
 * available."  It is available now, because Phase 6 already writes one
 * refresh-token row per login and Phase 8 records where each came from.
 *
 * Counts DISTINCT non-null origins among live sessions. The threshold is 3 and
 * not 2 on purpose: one phone moving between mobile data and wifi is two
 * origins and one honest person.
 */
async function concurrentSessionOrigins({ windowStart, threshold, limit }) {
  const result = await db.analyticsQuery(
    `SELECT user_id                                AS "userId",
            COUNT(DISTINCT origin_hash)::int       AS "originCount",
            COUNT(*)::int                          AS "sessionCount",
            COUNT(DISTINCT device_label)::int      AS "deviceKinds",
            MIN(issued_at)                         AS "firstSeen",
            MAX(issued_at)                         AS "lastSeen"
       FROM refresh_tokens
      WHERE revoked_at IS NULL
        AND expires_at > now()
        AND issued_at >= $1
        AND origin_hash IS NOT NULL
      GROUP BY user_id
     HAVING COUNT(DISTINCT origin_hash) >= $2
      ORDER BY COUNT(DISTINCT origin_hash) DESC
      LIMIT $3`,
    [windowStart, threshold, limit]
  );
  return result.rows;
}

/**
 * Signals for the per-account risk score.
 *
 * One query rather than four, because the score is computed for a bounded set
 * of candidate accounts and issuing four round-trips per account is the N+1
 * pattern §19 was careful to keep out of this codebase.
 */
async function riskSignalsForUsers(userIds) {
  if (!Array.isArray(userIds) || userIds.length === 0) return [];

  const result = await db.analyticsQuery(
    `SELECT u.id                                   AS "userId",
            u.created_at                           AS "accountCreatedAt",
            u.email_verified                       AS "emailVerified",
            u.provider,
            u.status,
            u.country_code                         AS "countryCode",
            u.signup_origin_hash                   AS "originHash",
            COALESCE(g.generations, 0)::int        AS "generations",
            COALESCE(r.rewards, 0)::int            AS "rewards",
            COALESCE(o.origin_siblings, 1)::int    AS "originSiblings"
       FROM public.users u
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS generations FROM generation_events ge WHERE ge.user_id = u.id
       ) g ON TRUE
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS rewards FROM daily_rewards dr WHERE dr.user_id = u.id
       ) r ON TRUE
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS origin_siblings
           FROM public.users s
          WHERE s.signup_origin_hash IS NOT NULL
            AND s.signup_origin_hash = u.signup_origin_hash
       ) o ON TRUE
      WHERE u.id = ANY($1::uuid[])`,
    [userIds]
  );
  return result.rows;
}

module.exports = {
  registrationVelocity,
  generationVelocity,
  rewardFarmingByOrigin,
  adminAdjustmentVolume,
  concurrentSessionOrigins,
  riskSignalsForUsers,
};
