const jwt = require('jsonwebtoken');
const { logAuthFailure, logUnexpectedError } = require('../utils/securityEvents');
const sessionService = require('../services/sessionService');

async function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    logAuthFailure(req, { reason: "no_header" });
    return res.status(401).json({ message: "No authorization header provided." });
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    logAuthFailure(req, { reason: "malformed_header" });
    return res.status(401).json({ message: "Authorization header must be in the format 'Bearer <token>'." });
  }

  const token = parts[1];
  let decoded;

  try {
    const secret = process.env.SUPABASE_JWT_SECRET;
    if (!secret) {
      throw new Error("SUPABASE_JWT_SECRET is not configured on the server.");
    }

    // SEC-1.1: pin the algorithm and require the `aud` claim that only access
    // tokens carry. Refresh tokens are signed with the same secret but never
    // have an `aud`, so a 30-day refresh JWT presented as a Bearer token is
    // rejected here instead of granting full API access and outliving logout.
    decoded = jwt.verify(token, secret, {
      algorithms: ['HS256'],
      audience: 'authenticated'
    });

    // Tokens issued after SEC-1.1 also carry an explicit `type` claim; reject
    // anything that declares itself as something other than an access token.
    if (decoded.type !== undefined && decoded.type !== 'access') {
      logAuthFailure(req, { reason: "wrong_token_type" });
      return res.status(401).json({ message: "Invalid or expired access token." });
    }
  } catch (err) {
    // The library's message is not logged: it can name the algorithm and echo
    // parts of the input. A fixed label is all an operator needs, and all an
    // attacker gets.
    logAuthFailure(req, { reason: "invalid_token" });
    return res.status(401).json({ message: "Invalid or expired access token." });
  }

  // ---------------------------------------------------------------------
  // Phase 6: the signature is necessary but no longer sufficient.
  //
  // Everything above is pure cryptography over a token the client holds, so
  // it can only answer "was this minted by us and has it expired on its own
  // schedule". It cannot answer "is this session still allowed to exist",
  // which is what logout-everywhere, password change and suspension all need.
  // That requires server state, so this is one indexed primary-key read per
  // authenticated request. See sessionService.getUserSessionState for why it
  // is deliberately not cached.
  // ---------------------------------------------------------------------
  let sessionState;
  try {
    sessionState = await sessionService.getUserSessionState(decoded.sub);
  } catch (err) {
    // FAIL CLOSED. If session state cannot be read we cannot tell a valid
    // session from a revoked one, and the whole point of this phase is that
    // a revoked session stops working. Serving the request would mean a
    // database blip silently restores every token this middleware exists to
    // refuse. A 503 is the honest answer, and /readyz already reports the
    // same outage to the platform.
    logUnexpectedError(req, err, { where: "authMiddleware.sessionState" });
    return res.status(503).json({ message: "Service temporarily unavailable." });
  }

  if (!sessionState) {
    // Valid signature, no such user - a deleted account holding a live token.
    logAuthFailure(req, { reason: "user_not_found" });
    return res.status(401).json({ message: "Invalid or expired access token." });
  }

  // SEC-18.2: suspension takes effect on the very next request rather than at
  // next login. An account worth suspending is precisely one that will not
  // voluntarily re-authenticate, so "enforced at login" would enforce nothing
  // for up to the token's full remaining lifetime.
  if (sessionState.status !== sessionService.ACTIVE_STATUS) {
    logAuthFailure(req, { reason: "account_not_active", subject: decoded.sub });
    return res.status(403).json({
      message: "This account has been suspended. Please contact support.",
      code: "ACCOUNT_SUSPENDED"
    });
  }

  // token_version: the global session epoch. A token minted before the last
  // bump is refused here even though its signature is perfectly valid and its
  // `exp` has not passed.
  //
  // A missing `tv` claim is read as 0, not rejected: every access token issued
  // before this deploy lacks the claim, and the column starts at 0, so those
  // sessions keep working until something actually revokes them. The first
  // bump for a user invalidates their legacy tokens along with the rest.
  const tokenVersion = typeof decoded.tv === 'number' ? decoded.tv : 0;
  if (tokenVersion !== sessionState.token_version) {
    logAuthFailure(req, { reason: "token_version_mismatch", subject: decoded.sub });
    return res.status(401).json({
      message: "Session has been revoked. Please sign in again.",
      code: "SESSION_REVOKED"
    });
  }

  // Supplying standard user payload
  req.user = {
    id: decoded.sub, // sub is user UUID in Supabase standard
    email: decoded.email,
    role: decoded.role
  };

  next();
}

/**
 * Strict variant for routes shared with the Admin Dashboard (e.g.
 * GET /api/categories, GET /api/styles). Must run after `optionalAdminAuth`
 * so `req.admin` is already set when the caller is the dashboard - in that
 * case this just calls next() unchecked, exactly like today. Any other
 * caller (mobile app, anonymous) is required to present a valid Supabase
 * user JWT, delegating to the same authMiddleware used everywhere else
 * rather than duplicating the verification logic.
 */
function requireUserOrAdmin(req, res, next) {
  if (req.admin) {
    return next();
  }
  return authMiddleware(req, res, next);
}

module.exports = authMiddleware;
module.exports.requireUserOrAdmin = requireUserOrAdmin;
