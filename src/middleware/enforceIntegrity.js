const { AppError, ErrorCodes } = require("../utils/errors");
const { config } = require("../config/playIntegrityConfig");
const { IntegrityState } = require("../services/integrityAssessment");
const {
  EnforcementAction,
  resolveAction,
  certificateAllowlist,
} = require("../config/integrityPolicy");

/**
 * SEC-0.5 — enforcement.
 *
 *   verify (0.2) → interpret (0.3) → enforce (here)
 *
 * The first and only layer allowed to refuse a request over device integrity.
 * It reads req.integrity and req.integrityAssessment and nothing else: no
 * Google call, no token decode, no header inspection, and no re-derivation of
 * anything SEC-0.3 already decided. If this file ever needs to know what
 * "MEETS_DEVICE_INTEGRITY" means, the interpretation layer has a gap and that
 * is where the fix belongs.
 *
 * What it adds on top of SEC-0.3 is the one thing SEC-0.3 refuses to have an
 * opinion about: consequences. Which certificates are ours, which endpoints are
 * ready to deny, and how hard - all of it is data in config/integrityPolicy.js,
 * so staging a rollout or rolling one back is a variable change rather than a
 * deploy.
 */

/**
 * Certificate allowlisting.
 *
 * Lives here rather than in SEC-0.3 because "which signing certificates are
 * ours" is policy: it changes when keys rotate, and it is a list somebody
 * maintains. Interpretation only reports what Google said.
 *
 * Inert while the allowlist is empty, which is the shipping state - the digests
 * are not knowable until the app is on a Play track. A mismatch is treated as
 * MODIFIED_APP because that is exactly what it is: a binary signed by a key we
 * do not recognise, whatever else the verdict says about it.
 */
function checkCertificate(assessment, integrity) {
  if (certificateAllowlist.length === 0) return null;
  if (assessment.state !== IntegrityState.TRUSTED) return null;

  const appIntegrity =
    (integrity && integrity.verdict && integrity.verdict.appIntegrity) || {};
  const digests = Array.isArray(appIntegrity.certificateSha256Digest)
    ? appIntegrity.certificateSha256Digest.filter((d) => typeof d === "string")
    : [];

  if (digests.length === 0) {
    return { state: IntegrityState.MODIFIED_APP, reason: "certificate_absent" };
  }
  if (!digests.some((d) => certificateAllowlist.includes(d))) {
    return { state: IntegrityState.MODIFIED_APP, reason: "certificate_not_allowlisted" };
  }
  return null;
}

/**
 * One structured line per decision, whatever the outcome.
 *
 * Every field here is backend-derived. The token digest comes from SEC-0.2 and
 * is a 12-character prefix, never the token. Verdict *labels* are logged;
 * payloads are not.
 */
function logDecision(req, decision, assessment) {
  const line = JSON.stringify({
    event: "integrity_policy",
    action: decision.action,
    blocked: decision.action === EnforcementAction.HARD_FAIL,
    degraded: decision.action === EnforcementAction.SOFT_FAIL,
    state: assessment.state,
    effectiveState: decision.effectiveState,
    deserved: decision.deserved,
    endpointCeiling: decision.endpointCeiling,
    globalCeiling: decision.globalCeiling,
    endpoint: decision.endpoint,
    source: assessment.source,
    reason: decision.reason || assessment.reason || null,
    app: assessment.app,
    device: assessment.device,
    deviceLabels: assessment.deviceLabels,
    licensing: assessment.licensing,
    attributableToCaller: assessment.attributableToCaller,
    userId: (req.user && req.user.id) || null,
    tokenDigest: assessment.tokenDigest || null,
  });

  // WARN and above are what alerting should key on; LOG is the firehose.
  if (decision.action === EnforcementAction.LOG) {
    console.log(line);
  } else {
    console.warn(line);
  }
}

/**
 * The response for a blocked request.
 *
 * Deliberately uniform: the same code and the same message for a modified app,
 * a replayed token and a tampered request. Telling the caller *which* check
 * failed turns this endpoint into an oracle they can tune an attack against.
 * The detail goes to the log, where the operator can see it and the attacker
 * cannot.
 */
function blockedError() {
  return new AppError(
    ErrorCodes.INTEGRITY_BLOCKED,
    "This request could not be verified. Please reinstall the app from Google Play and try again.",
    403
  );
}

function enforceIntegrity(req, res, next) {
  try {
    const assessment = req.integrityAssessment;

    if (!assessment || typeof assessment.state !== "string") {
      // SEC-0.3 did not run. Our wiring gap, not the caller's problem - so it
      // is recorded and allowed, never denied.
      req.integrityPolicy = {
        action: EnforcementAction.LOG,
        blocked: false,
        degraded: false,
        reason: "no_assessment",
      };
      console.warn(
        JSON.stringify({ event: "integrity_policy", action: "log", reason: "no_assessment" })
      );
      return next();
    }

    // Certificate allowlisting can only make the state worse, never better.
    const certOverride = checkCertificate(assessment, req.integrity);
    const effectiveState = certOverride ? certOverride.state : assessment.state;

    const resolved = resolveAction({
      state: effectiveState,
      endpoint: assessment.endpoint || "unknown",
      enforcement: config.enforcement,
    });

    const decision = {
      ...resolved,
      effectiveState,
      reason: certOverride ? certOverride.reason : resolved.reason,
    };

    req.integrityPolicy = {
      action: decision.action,
      blocked: decision.action === EnforcementAction.HARD_FAIL,
      degraded: decision.action === EnforcementAction.SOFT_FAIL,
      state: effectiveState,
      endpoint: decision.endpoint,
      reason: decision.reason,
    };

    logDecision(req, decision, assessment);

    if (decision.action === EnforcementAction.HARD_FAIL) {
      return next(blockedError());
    }

    // LOG, WARN and SOFT_FAIL all continue. SOFT_FAIL leaves `degraded` set for
    // a downstream consumer to act on; nothing consumes it yet, and that is the
    // point of having a rung between observing and denying.
    return next();
  } catch (err) {
    // A bug in policy must never be the reason a paying user is refused. The
    // failure mode is always "allow and record".
    console.error("[enforceIntegrity] unexpected error:", err && err.message);
    req.integrityPolicy = {
      action: EnforcementAction.LOG,
      blocked: false,
      degraded: false,
      reason: "policy_error",
    };
    return next();
  }
}

module.exports = enforceIntegrity;
module.exports.__testing = { checkCertificate, blockedError };
