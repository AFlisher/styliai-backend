const db = require("../../config/db");
const sessionService = require("../sessionService");
const { logger } = require("../../utils/logger");

/**
 * SEC-18.2 (Phase 8 half) - automatic enforcement, reusing Phase 6's mechanism.
 *
 * PHASE 6 BUILT THE CAPABILITY. `users.status`, the `token_version` epoch, and
 * refresh-family revocation already exist, are already checked by
 * authMiddleware on every request, and are already exposed to admins as
 * suspend/reinstate. The roadmap's own note is explicit that Phase 6 shipped
 * the capability and deferred the automatic trigger to Phase 8.
 *
 * SO THIS FILE DELIBERATELY INVENTS NOTHING. It performs the SAME three writes,
 * in the same order, in one transaction:
 *   1. status            - refused by authMiddleware, login, refresh, Google.
 *   2. token_version + 1 - every outstanding access token mismatches at once.
 *   3. family revocation - no refresh token can mint a replacement.
 *
 * A second suspension mechanism would be strictly worse than reusing this one:
 * two code paths that must stay consistent about what "suspended" means, only
 * one of which authMiddleware was written against.
 *
 * WHY NOT JUST CALL adminController.setUserStatus? Because it is an HTTP
 * handler - it takes (req, res), reads `req.admin.id` for the actor, and
 * writes a response. Automatic action has no request, no admin, and nothing to
 * respond to. Rather than fake a request object (which would also fabricate an
 * admin identity into the audit trail), the shared behaviour is expressed here
 * and the actor is recorded honestly as the system.
 */

/**
 * The `status_changed_by` column is a UUID referencing an admin. An automated
 * action has no admin, so the column stays NULL and the ACTOR IS RECORDED IN
 * THE REASON STRING instead. That is deliberate: writing some placeholder admin
 * id would put a false name in the accountability record SEC-15.1 exists to
 * keep honest, and a NULL that means "the system did this" is unambiguous when
 * paired with a reason that says which detector.
 */
function systemReason(detector, evidence) {
  const summary = evidence && typeof evidence === "object"
    ? Object.entries(evidence)
        .filter(([, v]) => typeof v === "number" || typeof v === "string")
        .slice(0, 4)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ")
    : "";
  return `auto:${detector}${summary ? ` (${summary})` : ""}`.slice(0, 500);
}

/**
 * Suspends an account automatically.
 *
 * TRIGGER    - a detector finding at the configured minimum severity, on a
 *              detector not in the never-auto-suspend list, with automatic
 *              enforcement explicitly enabled. All three are required.
 * EVIDENCE   - the finding's `evidence` JSON (counts, thresholds, window) is
 *              persisted on the abuse_findings row and summarised into
 *              `status_reason`, so the account itself carries a pointer to why.
 * ROLLBACK   - `POST /api/admin/users/:id/reinstate` (Phase 6, superadmin).
 *              It sets status back to 'active', bumps token_version again and
 *              revokes remaining families, so the user simply signs in again.
 *              Nothing here is destructive: no data is deleted, no balance is
 *              altered, and the account is fully restored by one existing
 *              endpoint. That reversibility is why 'suspended' is used rather
 *              than 'banned' - an automated system should never reach for the
 *              option that reads as final.
 *
 * Returns `{ suspended: boolean, reason }` and NEVER THROWS. A failure to
 * enforce must not break the sweep that found the problem, and must certainly
 * not break the request that opportunistically triggered the sweep.
 */
async function autoSuspend({ userId, detector, evidence, status = "suspended" }) {
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");

    // Same single statement Phase 6 uses: status and epoch move together. Split
    // across two statements, a crash between them leaves an account marked
    // suspended whose live tokens still work - the exact failure the mechanism
    // exists to prevent.
    //
    // The `status = 'active'` guard makes this idempotent: a repeated sweep
    // over the same window must not bump token_version again on an account it
    // already suspended, which would pointlessly invalidate the sessions of a
    // user an admin had just reinstated.
    const updated = await client.query(
      `UPDATE public.users
          SET status = $1,
              status_reason = $2,
              status_changed_at = now(),
              status_changed_by = NULL,
              token_version = token_version + 1,
              refresh_token_hash = NULL
        WHERE id = $3
          AND status = 'active'
        RETURNING id, status, token_version`,
      [status, systemReason(detector, evidence), userId]
    );

    if (updated.rows.length === 0) {
      await client.query("ROLLBACK");
      // Either no such user, or already non-active. Both are non-events.
      return { suspended: false, reason: "not_active_or_missing" };
    }

    await sessionService.revokeAllUserRefreshTokens(userId, `auto_${detector}`, client);

    await client.query("COMMIT");

    // SEC-16.3 conventions: structured, no PII. The user id is an opaque
    // internal identifier and is already logged on every authenticated
    // request; the email, the origin and the evidence values that could
    // identify a person are deliberately absent.
    logger.warn("abuse_auto_suspend", {
      event: "abuse_auto_suspend",
      userId,
      detector,
      status,
      tokenVersion: updated.rows[0].token_version,
      rollback: "POST /api/admin/users/:id/reinstate",
    });

    return { suspended: true, reason: "suspended" };
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch (_) { /* already failed */ }
    logger.error("abuse_auto_suspend_failed", {
      event: "abuse_auto_suspend_failed",
      userId,
      detector,
      error: (err && err.message ? String(err.message) : "unknown").slice(0, 300),
    });
    return { suspended: false, reason: "error" };
  } finally {
    client.release();
  }
}

/**
 * Decides whether a finding may trigger automatic action.
 *
 * Kept separate from `autoSuspend` and pure, so the POLICY can be asserted in
 * tests without touching a database - the question "would this have suspended
 * someone?" is the one worth being able to answer cheaply and often.
 */
function shouldAutoSuspend(finding, policy) {
  const e = policy.enforcement;
  if (!e.autoSuspendEnabled) return { allowed: false, reason: "disabled" };
  if (!finding.userId) return { allowed: false, reason: "no_subject" };
  if (e.neverAutoSuspend.includes(finding.detector)) {
    // Origin-scoped detectors implicate everyone behind a shared address.
    return { allowed: false, reason: "detector_excluded" };
  }
  if (finding.severity !== e.autoSuspendMinSeverity) {
    return { allowed: false, reason: "severity_below_threshold" };
  }
  return { allowed: true, reason: "eligible" };
}

module.exports = { autoSuspend, shouldAutoSuspend, systemReason };
