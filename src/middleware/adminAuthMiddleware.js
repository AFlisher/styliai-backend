const jwt = require('jsonwebtoken');
const sessionService = require('../services/sessionService');

async function adminAuthMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    return res.status(401).json({ message: "No authorization header provided." });
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return res.status(401).json({ message: "Authorization header must be in the format 'Bearer <token>'." });
  }

  const token = parts[1];

  try {
    const secret = process.env.ADMIN_JWT_SECRET;
    if (!secret) {
      throw new Error("ADMIN_JWT_SECRET is not configured on the server.");
    }

    // SEC-1.7: pin the algorithm. Without this, jsonwebtoken widens the
    // accepted set to the whole HMAC family whenever the key resolves to a
    // secret - a set inherited from the dependency's defaults rather than
    // stated here. Admin tokens are signed HS256, so HS256 is all we accept.
    const decoded = jwt.verify(token, secret, { algorithms: ['HS256'] });

    if (decoded.role !== 'admin') {
      return res.status(403).json({ message: "Admin privileges required." });
    }

    // SEC-15.3 (Phase 6): the admin token lives in the dashboard's
    // localStorage, so an XSS exfiltrates it and there was previously no way
    // to stop it before its 2h `exp`. Same mechanism as the user path - one
    // indexed read, compared against the epoch the token was minted at.
    // Admin traffic is human-paced, so the per-request cost is irrelevant here.
    let sessionState;
    try {
      sessionState = await sessionService.getAdminSessionState(decoded.sub);
    } catch (dbErr) {
      // Fail closed, for the same reason as the user middleware: an
      // unreadable session table must not silently re-enable revoked tokens.
      console.error("Admin session state read failed:", dbErr.message);
      return res.status(503).json({ message: "Service temporarily unavailable." });
    }

    if (!sessionState) {
      return res.status(401).json({ message: "Invalid or expired admin token." });
    }

    // Absent `tv` reads as 0 so admin tokens minted before this deploy keep
    // working until the first revocation, exactly as on the user path.
    const tokenVersion = typeof decoded.tv === 'number' ? decoded.tv : 0;
    if (tokenVersion !== sessionState.token_version) {
      return res.status(401).json({
        message: "Admin session has been revoked. Please sign in again.",
        code: "SESSION_REVOKED"
      });
    }

    req.admin = {
      id: decoded.sub,
      email: decoded.email,
      role: decoded.role,
      // SEC-15.4: the authorization tier, read by requireAdminRole. Carried
      // through as-is, including `undefined` for tokens minted before roles
      // existed - roleSatisfies fails closed on anything it doesn't recognise,
      // so an absent claim denies rather than grandfathering full privilege.
      adminRole: decoded.adminRole
    };

    next();
  } catch (err) {
    console.error("Admin JWT verification error:", err.message);
    return res.status(401).json({ message: "Invalid or expired admin token." });
  }
}

/**
 * Non-rejecting variant for routes that serve both the public mobile app and
 * the Admin Dashboard from the same endpoint (e.g. GET /api/styles). Attaches
 * `req.admin` when a valid admin token is present, exactly like the strict
 * middleware - but a missing/invalid/malformed token just falls through to
 * `next()` instead of failing the request, so the route handler can shape its
 * response based on whether `req.admin` was set.
 */
async function optionalAdminAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    return next();
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return next();
  }

  const token = parts[1];

  try {
    const secret = process.env.ADMIN_JWT_SECRET;
    if (!secret) {
      return next();
    }

    // SEC-1.7: pinned identically to the strict middleware above - the two
    // paths must not disagree about what constitutes a valid admin token.
    const decoded = jwt.verify(token, secret, { algorithms: ['HS256'] });

    if (decoded.role === 'admin') {
      // SEC-15.3: revocation is checked here too. The file already warns that
      // these two paths must not disagree about what constitutes a valid admin
      // token; if only the strict path honoured token_version, a revoked token
      // would still set `req.admin` on the shared catalog reads and still
      // receive the admin-shaped response.
      //
      // Unlike the strict path this stays FAIL-OPEN on a database error, but
      // open here means "treat as anonymous", not "treat as admin" - the
      // caller simply gets the public response. Rejecting instead would take
      // down GET /api/styles for every mobile user whenever the admin table
      // is briefly unreachable, which is a far worse trade for a request that
      // was never going to be privileged.
      let sessionState = null;
      try {
        sessionState = await sessionService.getAdminSessionState(decoded.sub);
      } catch (dbErr) {
        return next();
      }

      const tokenVersion = typeof decoded.tv === 'number' ? decoded.tv : 0;
      if (sessionState && tokenVersion === sessionState.token_version) {
        req.admin = {
          id: decoded.sub,
          email: decoded.email,
          role: decoded.role,
          // SEC-15.4: carried here too. No route currently pairs
          // optionalAdminAuth with a role guard, but the two paths must not
          // disagree about what a req.admin contains - if they did, adding a
          // guard to one of these shared endpoints later would fail closed for
          // reasons nobody would think to look for here.
          adminRole: decoded.adminRole
        };
      }
    }

    next();
  } catch (err) {
    // Not a valid admin token (e.g. a mobile user's Supabase JWT) - treat as
    // an unauthenticated request rather than rejecting it.
    next();
  }
}

module.exports = adminAuthMiddleware;
module.exports.optionalAdminAuth = optionalAdminAuth;
