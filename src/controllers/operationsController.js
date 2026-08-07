const db = require("../config/db");
const adminAuditModel = require("../models/adminAuditModel");
const securityEventModel = require("../models/securityEventModel");
const { clampLimit } = require("../utils/pagination");

/**
 * Operations Center — read-only surfaces over data that already exists.
 *
 * Every endpoint here is a VIEW, not a new source of truth:
 *   - Admin Actions / Account Deletions / Credit Adjustments / Suspensions &
 *     Reinstatements are all `admin_audit_log`, filtered by `action` - the
 *     same table SEC-15.1's audit middleware already writes to on every
 *     privileged mutation (including the abuse-review and sweep endpoints,
 *     which write here via that same global middleware, not via a separate
 *     path). There is exactly one admin accountability table; this is its
 *     first reader.
 *   - Security Events / Failed Login Events are `security_events`, the new
 *     persisted half of securityEvents.js's auth_failure/authz_failure
 *     categories (see migration_security_events.sql).
 *   - Purchase Verification History unions the one real verification ledger
 *     that exists today (`processed_ad_transactions`, AdMob's server-side
 *     reward verification) with `wallet_transactions` rows of type
 *     'purchase' - a schema-allowed value nothing inserts yet, since no IAP
 *     flow has shipped. The endpoint is honest about that in its response
 *     rather than fabricating verification history that doesn't exist.
 *
 * All three are superadmin-tier: audit rows carry admin emails and raw
 * request IPs (see adminRoutePolicy.js), a broader exposure than the
 * abuse-findings reads (viewer-tier), which deliberately never surface raw
 * IPs at all.
 */

/** GET /api/admin/audit-log?action=&targetType=&adminId=&q=&from=&to=&limit=&offset= */
async function listAuditLog(req, res) {
  try {
    const query = req.query || {};
    const limit = clampLimit(query.limit, { def: 50, max: 200 });
    const offset = Math.max(0, Math.floor(Number(query.offset)) || 0);

    const { rows, total } = await adminAuditModel.list({
      limit,
      offset,
      action: typeof query.action === "string" ? query.action : undefined,
      targetType: typeof query.targetType === "string" ? query.targetType : undefined,
      adminId: typeof query.adminId === "string" ? query.adminId : undefined,
      q: typeof query.q === "string" ? query.q : undefined,
      from: typeof query.from === "string" ? query.from : undefined,
      to: typeof query.to === "string" ? query.to : undefined,
    });

    res.json({ entries: rows, total, limit, offset });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Internal server error." });
  }
}

const SECURITY_EVENT_TYPES = new Set(["auth_failure", "authz_failure"]);

/** GET /api/admin/security-events?eventType=&q=&from=&to=&limit=&offset= */
async function listSecurityEvents(req, res) {
  try {
    const query = req.query || {};
    const limit = clampLimit(query.limit, { def: 50, max: 200 });
    const offset = Math.max(0, Math.floor(Number(query.offset)) || 0);

    const eventType = typeof query.eventType === "string" ? query.eventType : "all";
    if (eventType !== "all" && !SECURITY_EVENT_TYPES.has(eventType)) {
      return res.status(400).json({ message: "eventType must be one of: all, auth_failure, authz_failure." });
    }

    const { rows, total } = await securityEventModel.list({
      limit,
      offset,
      eventType,
      q: typeof query.q === "string" ? query.q : undefined,
      from: typeof query.from === "string" ? query.from : undefined,
      to: typeof query.to === "string" ? query.to : undefined,
    });

    res.json({ events: rows, total, limit, offset });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Internal server error." });
  }
}

const PURCHASE_SOURCES = new Set(["purchase", "ad_reward"]);

/** GET /api/admin/purchases/verification-history?source=&limit=&offset= */
async function listPurchaseVerifications(req, res) {
  try {
    const query = req.query || {};
    const limit = clampLimit(query.limit, { def: 50, max: 200 });
    const offset = Math.max(0, Math.floor(Number(query.offset)) || 0);

    const source = typeof query.source === "string" ? query.source : "all";
    if (source !== "all" && !PURCHASE_SOURCES.has(source)) {
      return res.status(400).json({ message: "source must be one of: all, purchase, ad_reward." });
    }
    const sourceFilter = source === "all" ? null : source;

    const rows = await db.query(
      `SELECT id, source, "userId", amount, description, "createdAt"
         FROM (
           SELECT id::text AS id, 'purchase' AS source, user_id AS "userId", amount,
                  description, created_at AS "createdAt"
             FROM wallet_transactions
            WHERE type = 'purchase'
           UNION ALL
           SELECT transaction_id AS id, 'ad_reward' AS source, user_id AS "userId", reward_amount AS amount,
                  'AdMob rewarded-ad verification' AS description, created_at AS "createdAt"
             FROM processed_ad_transactions
         ) combined
        WHERE $1::text IS NULL OR source = $1
        ORDER BY "createdAt" DESC, id DESC
        LIMIT $2 OFFSET $3`,
      [sourceFilter, limit, offset]
    );

    const countRes = await db.query(
      `SELECT COUNT(*)::int AS total FROM (
         SELECT 'purchase' AS source FROM wallet_transactions WHERE type = 'purchase'
         UNION ALL
         SELECT 'ad_reward' AS source FROM processed_ad_transactions
       ) combined
       WHERE $1::text IS NULL OR source = $1`,
      [sourceFilter]
    );

    res.json({
      entries: rows.rows,
      total: countRes.rows[0]?.total ?? 0,
      limit,
      offset,
      note:
        "No in-app-purchase flow is implemented yet - wallet_transactions.type='purchase' is a " +
        "schema-allowed value nothing inserts today. This currently shows AdMob's server-side " +
        "reward-verification ledger, the one verification history that is real, and is ready to " +
        "surface actual IAP receipts once that ships.",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Internal server error." });
  }
}

module.exports = {
  listAuditLog,
  listSecurityEvents,
  listPurchaseVerifications,
};
