const abuseFindingModel = require("../models/abuseFindingModel");
const abuseDetection = require("../services/abuse/abuseDetection");
const sessionService = require("../services/sessionService");
const { policy } = require("../config/abusePolicy");
const { AppError, ErrorCodes } = require("../utils/errors");
const { clampLimit } = require("../utils/pagination");
const { logAuditEvent } = require("../utils/securityEvents");

/**
 * SEC-18.1 - the administrative review workflow.
 *
 * Detection without a place to look at it is a log file nobody reads. The
 * audit asks to "surface the top-N in the admin dashboard"; these endpoints are
 * that surface, plus the review actions that let a human close the loop.
 *
 * All of them are admin-authenticated and role-gated via
 * config/adminRoutePolicy.js like every other admin route. They are READ and
 * REVIEW only - the actual enforcement action remains Phase 6's existing
 * suspend/reinstate endpoints, so there is exactly one way to suspend an
 * account whether a human or a detector decided it.
 */

const REVIEW_OUTCOMES = new Set(["confirmed", "false_positive", "ignored"]);

/** GET /api/admin/abuse/findings?limit=&includeReviewed=&userId= */
async function listFindings(req, res, next) {
  try {
    const query = req.query || {};
    const limit = clampLimit(query.limit, { def: 50, max: 200 });
    const includeReviewed = String(query.includeReviewed) === "true";

    const rows = await abuseFindingModel.list({
      limit,
      includeReviewed,
      userId: query.userId || null,
    });

    return res.json({
      findings: rows,
      // Echoed so an operator reading the dashboard knows whether the system
      // is currently allowed to act on its own. A review queue that silently
      // changed from "advisory" to "enforcing" would be a nasty surprise.
      autoSuspendEnabled: policy.enforcement.autoSuspendEnabled,
    });
  } catch (err) {
    return next(err);
  }
}

/** GET /api/admin/abuse/risk?limit= */
async function topRisk(req, res, next) {
  try {
    const limit = clampLimit((req.query || {}).limit, { def: 25, max: 100 });
    const rows = await abuseFindingModel.topRisk({ limit });
    return res.json({
      users: rows,
      // Stated in the payload, not just in a doc, because a number labelled
      // "risk" on a dashboard will otherwise be read as a probability and
      // eventually as grounds for action on its own.
      note:
        "Score is a ranking aid for human review - not a probability, and not " +
        "used for any authorization decision. `factors` explains every contribution.",
    });
  } catch (err) {
    return next(err);
  }
}

/** POST /api/admin/abuse/findings/:id/review  { outcome } */
async function reviewFinding(req, res, next) {
  try {
    const { id } = req.params;
    const outcome = req.body && req.body.outcome;

    if (!REVIEW_OUTCOMES.has(outcome)) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        "outcome must be one of: confirmed, false_positive, ignored.",
        400
      );
    }

    const row = await abuseFindingModel.review({
      id,
      adminId: req.admin.id,
      outcome,
    });

    if (!row) {
      throw new AppError(ErrorCodes.NOT_FOUND, "No finding with this id.", 404);
    }

    // A false positive is a signal about the DETECTOR, not about the user, and
    // is the only evidence that would justify changing a threshold later. It is
    // recorded as a security event so the argument can be made from data.
    logAuditEvent(req, {
      action: "abuse_finding_review",
      outcome: "success",
      subject: row.userId || undefined,
      details: { detector: row.detector, reviewOutcome: row.reviewOutcome },
    });

    return res.json(row);
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/admin/abuse/sweep
 *
 * Runs the detectors immediately rather than waiting for the opportunistic
 * trigger. Exists because "I have just changed a threshold, did it help?" and
 * "something looks wrong right now" are both real operator needs, and neither
 * is served by a sweep that fires on someone else's traffic at an unpredictable
 * moment.
 *
 * Awaited, unlike the opportunistic path: the caller explicitly asked and is
 * waiting for the answer. Bounded by the same per-sweep limits.
 */
async function runSweepNow(req, res, next) {
  try {
    const summary = await abuseDetection.runSweep();
    logAuditEvent(req, { action: "abuse_sweep_manual", outcome: "success" });
    return res.json(summary);
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/admin/abuse/users/:id/sessions
 *
 * SEC-18.5's session list for one account. The investigative counterpart to a
 * concurrent-origin finding: "this account is live from four origins" is only
 * actionable if someone can then see them.
 *
 * Returns origin HASHES, never addresses - there is no path from this endpoint
 * back to an IP, by construction rather than by redaction.
 */
async function userSessions(req, res, next) {
  try {
    const rows = await sessionService.listLiveSessions(req.params.id, { limit: 50 });
    return res.json({ sessions: rows });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  listFindings,
  topRisk,
  reviewFinding,
  runSweepNow,
  userSessions,
};
