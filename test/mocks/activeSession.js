/**
 * Phase 6 test support: a live, active session at epoch 0.
 *
 * authMiddleware and adminAuthMiddleware now read session state (token_version
 * and account status) from the database on every authenticated request. Suites
 * that stub `db.query` with an ORDERED queue of `mockResolvedValueOnce` values
 * would otherwise have that queue consumed by the middleware's read, shifting
 * every subsequent expectation by one and failing for a reason that has
 * nothing to do with what they assert.
 *
 * Mocking the two read functions - rather than adding a response to each
 * queue - leaves those suites' `db.query` call expectations exactly as they
 * were, so this changes what they depend on, not what they prove.
 *
 * This deliberately does NOT stub the write side (bumpUserTokenVersion,
 * revokeAllUserRefreshTokens, consumeRefreshToken, ...). Those keep their real
 * implementations, so a suite that exercises revocation still exercises it.
 *
 * The properties this bypasses - a mismatched epoch is refused, a suspended
 * account is refused, an unknown identity is refused, and the read failing
 * closed - are asserted directly against real state in
 * test/critical/sessionRevocation.critical.test.js. That suite must never
 * require this helper, or the controls would be proving themselves against
 * their own stub.
 */
const actual = jest.requireActual("../../src/services/sessionService");

module.exports = {
  ...actual,
  getUserSessionState: jest.fn().mockResolvedValue({ token_version: 0, status: "active" }),
  getAdminSessionState: jest.fn().mockResolvedValue({ token_version: 0 }),
};
