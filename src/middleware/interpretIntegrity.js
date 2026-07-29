const { assessIntegrity } = require("../services/integrityAssessment");

/**
 * SEC-0.3 — the interpretation stage.
 *
 *   verifyIntegrity (SEC-0.2)  →  interpretIntegrity (here)  →  SEC-0.5 policy
 *
 * A three-line middleware on purpose. All of the thinking lives in
 * services/integrityAssessment.js, which is pure and synchronous and therefore
 * exhaustively testable without an HTTP request in sight. This exists only to
 * put the result somewhere SEC-0.5 can find it.
 *
 * It reads req.integrity and nothing else. It never touches a header, never
 * re-verifies, never contacts Google, and never denies or responds - the same
 * discipline SEC-0.2 follows, for the same reason: enforcement is SEC-0.5's,
 * and a layer that can reject is a layer that cannot be run in log-only mode.
 *
 * Must be mounted AFTER verifyIntegrity. Mounted without it, req.integrity is
 * undefined and the assessment comes back INDETERMINATE/no_integrity_annotation
 * - which is honest ("we learned nothing") rather than silently trusting.
 */
function interpretIntegrity(req, res, next) {
  try {
    req.integrityAssessment = assessIntegrity(req.integrity);
  } catch (err) {
    // assessIntegrity is already total; this is the outer seatbelt, so that a
    // classifier bug can never be the reason a paying user's generation fails.
    console.error("[interpretIntegrity] unexpected error:", err && err.message);
    req.integrityAssessment = assessIntegrity(undefined);
  }
  next();
}

module.exports = interpretIntegrity;
