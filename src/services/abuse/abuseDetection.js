const detectors = require("./detectors");
const findings = require("../../models/abuseFindingModel");
const enforcement = require("./enforcement");
const { scoreAccount } = require("./riskScore");
const { policy: defaultPolicy } = require("../../config/abusePolicy");
const { logger } = require("../../utils/logger");

/**
 * SEC-18.1 - the sweep that runs the detectors and records what they find.
 *
 * SCHEDULING. There is no scheduler in this codebase (SEC-20.x), so this runs
 * opportunistically: a request may trigger it, at most once per interval, and
 * never waits for it. That pattern is already established here by
 * integrityLedgerSweeper, and the two safety properties it relies on are
 * reproduced exactly:
 *
 *   - The interval gate is set SYNCHRONOUSLY before any async work starts, so a
 *     burst of concurrent requests cannot each launch their own sweep. Node
 *     runs the synchronous part to completion before yielding, so there is no
 *     interleaving window.
 *   - The promise is never awaited by the request and always carries a
 *     `.catch()`. An unhandled rejection from a fire-and-forget task is an
 *     uncaught exception, which in Node kills the process - the same hazard
 *     class as SEC-16.1's morgan token and SEC-15.1's response hook.
 *
 * Worst case if a sweep is missed: detection is late, which for a detector
 * whose findings a human reviews is a non-event. Worst case if it ran on every
 * request: a handful of aggregates per API call, which is why it does not.
 */

let lastSweepAt = 0;
let sweeping = false;

function windowFor(hours, now) {
  const end = new Date(now);
  const start = new Date(now - hours * 3600 * 1000);
  return { windowStart: start, windowEnd: end };
}

/**
 * Records one finding and applies enforcement policy to it.
 *
 * Enforcement is attempted only after the finding is persisted, so an account
 * can never be suspended by something that left no record of why.
 */
async function handleFinding(finding, policy) {
  const row = await findings.record(finding);

  const decision = enforcement.shouldAutoSuspend(
    { userId: finding.userId, detector: finding.detector, severity: finding.severity },
    policy
  );

  if (!decision.allowed) {
    // Logged at debug rather than warn: "we did not suspend anyone" is the
    // normal case and must not drown the stream that real events live in.
    return { ...row, enforcement: decision.reason };
  }

  const result = await enforcement.autoSuspend({
    userId: finding.userId,
    detector: finding.detector,
    evidence: finding.evidence,
    status: policy.enforcement.autoSuspendStatus,
  });

  if (result.suspended) {
    await findings.setAction(row.id, "suspended");
    return { ...row, action: "suspended", enforcement: "suspended" };
  }
  return { ...row, enforcement: result.reason };
}

/**
 * Runs every detector once over its own window.
 *
 * Each detector is independently guarded: one failing query must not abort the
 * others, because a detector that throws is a bug in that detector and losing
 * the other three findings to it makes the outage worse than the bug.
 */
async function runSweep({ now = Date.now(), policy = defaultPolicy } = {}) {
  const summary = {
    registrationVelocity: 0,
    generationVelocity: 0,
    rewardFarming: 0,
    adminAdjustments: 0,
    concurrentSessions: 0,
    suspended: 0,
    errors: [],
  };
  const limit = policy.maxFindingsPerSweep;
  const touchedUsers = new Set();

  // --- Detector 1: registration velocity per origin -------------------------
  try {
    const w = windowFor(policy.registration.windowHours, now);
    const rows = await detectors.registrationVelocity({
      ...w,
      threshold: policy.registration.perOriginThreshold,
      limit,
    });
    for (const r of rows) {
      const severity =
        r.accountCount >= policy.registration.perOriginHighThreshold ? "high" : "medium";
      await handleFinding({
        userId: null, // origin-scoped: implicates a group, not one account
        detector: "registration_velocity",
        severity,
        originHash: r.originHash,
        evidence: {
          accountCount: r.accountCount,
          threshold: policy.registration.perOriginThreshold,
          windowHours: policy.registration.windowHours,
          countryCount: r.countryCount,
        },
        windowStart: w.windowStart,
        windowEnd: w.windowEnd,
      }, policy);
      for (const id of r.userIds || []) touchedUsers.add(id);
      summary.registrationVelocity += 1;
    }
  } catch (err) {
    summary.errors.push({ detector: "registration_velocity", error: safeMessage(err) });
  }

  // --- Detector 2: generation velocity per user -----------------------------
  try {
    const w = windowFor(policy.generation.windowHours, now);
    const rows = await detectors.generationVelocity({
      ...w,
      threshold: policy.generation.perUserThreshold,
      limit,
    });
    for (const r of rows) {
      const severity =
        r.generationCount >= policy.generation.perUserHighThreshold ? "high" : "medium";
      const result = await handleFinding({
        userId: r.userId,
        detector: "generation_velocity",
        severity,
        originHash: r.originHash,
        evidence: {
          generationCount: r.generationCount,
          threshold: policy.generation.perUserThreshold,
          windowHours: policy.generation.windowHours,
        },
        windowStart: w.windowStart,
        windowEnd: w.windowEnd,
      }, policy);
      if (result.enforcement === "suspended") summary.suspended += 1;
      touchedUsers.add(r.userId);
      summary.generationVelocity += 1;
    }
  } catch (err) {
    summary.errors.push({ detector: "generation_velocity", error: safeMessage(err) });
  }

  // --- Detector 3a: reward farming per origin -------------------------------
  try {
    const w = windowFor(policy.wallet.windowHours, now);
    const rows = await detectors.rewardFarmingByOrigin({
      ...w,
      threshold: policy.wallet.rewardsPerOriginThreshold,
      limit,
    });
    for (const r of rows) {
      const severity =
        r.accountCount >= policy.wallet.rewardsPerOriginHighThreshold ? "high" : "medium";
      await handleFinding({
        userId: null,
        detector: "reward_farming_origin",
        severity,
        originHash: r.originHash,
        evidence: {
          accountCount: r.accountCount,
          creditsClaimed: r.creditsClaimed,
          threshold: policy.wallet.rewardsPerOriginThreshold,
          windowHours: policy.wallet.windowHours,
        },
        windowStart: w.windowStart,
        windowEnd: w.windowEnd,
      }, policy);
      summary.rewardFarming += 1;
    }
  } catch (err) {
    summary.errors.push({ detector: "reward_farming_origin", error: safeMessage(err) });
  }

  // --- Detector 3b: admin adjustment volume ---------------------------------
  try {
    const w = windowFor(policy.wallet.windowHours, now);
    const row = await detectors.adminAdjustmentVolume({
      ...w,
      threshold: policy.wallet.adminAdjustmentsThreshold,
    });
    if (row) {
      await handleFinding({
        userId: null,
        detector: "admin_adjustment_volume",
        // Never 'high': this detector reports a RATE, and a legitimate support
        // burst looks identical to an abusive one. It is an invitation to read
        // SEC-15.1's audit log, never grounds for automatic action.
        severity: "medium",
        originHash: null,
        evidence: {
          adjustmentCount: row.adjustmentCount,
          affectedUsers: row.affectedUsers,
          creditsGranted: row.creditsGranted,
          threshold: policy.wallet.adminAdjustmentsThreshold,
          windowHours: policy.wallet.windowHours,
        },
        windowStart: w.windowStart,
        windowEnd: w.windowEnd,
      }, policy);
      summary.adminAdjustments += 1;
    }
  } catch (err) {
    summary.errors.push({ detector: "admin_adjustment_volume", error: safeMessage(err) });
  }

  // --- Detector 4 (SEC-18.5): concurrent session origins --------------------
  try {
    const w = windowFor(policy.session.windowHours, now);
    const rows = await detectors.concurrentSessionOrigins({
      windowStart: w.windowStart,
      threshold: policy.session.distinctOriginThreshold,
      limit,
    });
    for (const r of rows) {
      const severity =
        r.originCount >= policy.session.distinctOriginHighThreshold ? "high" : "medium";
      const result = await handleFinding({
        userId: r.userId,
        detector: "concurrent_session_origins",
        severity,
        originHash: null,
        evidence: {
          originCount: r.originCount,
          sessionCount: r.sessionCount,
          deviceKinds: r.deviceKinds,
          threshold: policy.session.distinctOriginThreshold,
          windowHours: policy.session.windowHours,
        },
        windowStart: w.windowStart,
        windowEnd: w.windowEnd,
      }, policy);
      if (result.enforcement === "suspended") summary.suspended += 1;
      touchedUsers.add(r.userId);
      summary.concurrentSessions += 1;
    }
  } catch (err) {
    summary.errors.push({ detector: "concurrent_session_origins", error: safeMessage(err) });
  }

  // --- Risk scores for every account any detector touched -------------------
  // Scored only for accounts a detector implicated, not for the whole user
  // table: scoring everyone would be an aggregate whose cost grows with total
  // registrations, which is SEC-19.1's failure mode in a new place.
  try {
    const ids = [...touchedUsers].slice(0, policy.maxFindingsPerSweep);
    if (ids.length) {
      const signals = await detectors.riskSignalsForUsers(ids);
      for (const s of signals) {
        const { score, factors } = scoreAccount(s, new Date(now));
        await findings.upsertRiskScore({ userId: s.userId, score, factors });
      }
      summary.scored = signals.length;
    }
  } catch (err) {
    summary.errors.push({ detector: "risk_score", error: safeMessage(err) });
  }

  const total =
    summary.registrationVelocity +
    summary.generationVelocity +
    summary.rewardFarming +
    summary.adminAdjustments +
    summary.concurrentSessions;

  // SEC-16.3 conventions: one structured line per sweep. Counts only - no user
  // ids, no origins, no emails. This is the line an operator greps to answer
  // "is detection running, and is it finding anything".
  logger.info("abuse_sweep", {
    event: "abuse_sweep",
    findings: total,
    suspended: summary.suspended,
    scored: summary.scored || 0,
    errors: summary.errors.length,
    autoSuspendEnabled: policy.enforcement.autoSuspendEnabled,
  });

  return summary;
}

function safeMessage(err) {
  return (err && err.message ? String(err.message) : "unknown").slice(0, 300);
}

/**
 * Fire-and-forget entry point, called from the request path.
 *
 * Returns whether a sweep was STARTED, not whether one finished. The caller
 * must not await it.
 */
function maybeSweep({ now = Date.now(), policy = defaultPolicy } = {}) {
  // Both gates set synchronously, before any await - see the header.
  if (!policy.sweepEnabled) return false;
  if (sweeping) return false;
  if (now - lastSweepAt < policy.sweepIntervalMs) return false;
  sweeping = true;
  lastSweepAt = now;

  runSweep({ now, policy })
    .catch((err) => {
      logger.error("abuse_sweep_failed", {
        event: "abuse_sweep_failed",
        error: safeMessage(err),
      });
    })
    .finally(() => {
      sweeping = false;
    });

  return true;
}

/** Test seam. */
function resetSweepState() {
  lastSweepAt = 0;
  sweeping = false;
}

/**
 * System Health module: the in-memory sweep state, read-only. Same shape as
 * integrityLedgerSweeper.getStatus() - `lastSweepAt` is `null` until the
 * first sweep this process has actually started, rather than the epoch.
 */
function getSweepStatus() {
  return { lastSweepAt: lastSweepAt ? new Date(lastSweepAt).toISOString() : null, sweeping };
}

module.exports = { runSweep, maybeSweep, resetSweepState, handleFinding, getSweepStatus };
