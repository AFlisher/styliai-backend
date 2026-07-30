const jwt = require('jsonwebtoken');
const { logAuthFailure } = require('../utils/securityEvents');

function authMiddleware(req, res, next) {
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

  try {
    const secret = process.env.SUPABASE_JWT_SECRET;
    if (!secret) {
      throw new Error("SUPABASE_JWT_SECRET is not configured on the server.");
    }

    // SEC-1.1: pin the algorithm and require the `aud` claim that only access
    // tokens carry. Refresh tokens are signed with the same secret but never
    // have an `aud`, so a 30-day refresh JWT presented as a Bearer token is
    // rejected here instead of granting full API access and outliving logout.
    const decoded = jwt.verify(token, secret, {
      algorithms: ['HS256'],
      audience: 'authenticated'
    });

    // Tokens issued after SEC-1.1 also carry an explicit `type` claim; reject
    // anything that declares itself as something other than an access token.
    if (decoded.type !== undefined && decoded.type !== 'access') {
      logAuthFailure(req, { reason: "wrong_token_type" });
      return res.status(401).json({ message: "Invalid or expired access token." });
    }

    // Supplying standard user payload
    req.user = {
      id: decoded.sub, // sub is user UUID in Supabase standard
      email: decoded.email,
      role: decoded.role
    };

    next();
  } catch (err) {
    // The library's message is not logged: it can name the algorithm and echo
    // parts of the input. A fixed label is all an operator needs, and all an
    // attacker gets.
    logAuthFailure(req, { reason: "invalid_token" });
    return res.status(401).json({ message: "Invalid or expired access token." });
  }
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
