const jwt = require('jsonwebtoken');

/**
 * Non-rejecting variant of authMiddleware for routes that serve both
 * anonymous and logged-in mobile users from the same endpoint (e.g.
 * GET /api/styles?recommended=true). Attaches `req.user` when a valid
 * Supabase JWT is present, exactly like the strict middleware - but a
 * missing/invalid/malformed token just falls through to `next()` instead of
 * failing the request, so the route handler can treat the caller as
 * anonymous instead of rejecting it.
 */
function optionalAuthMiddleware(req, res, next) {
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
    const secret = process.env.SUPABASE_JWT_SECRET;
    if (!secret) {
      return next();
    }

    const decoded = jwt.verify(token, secret);
    req.user = {
      id: decoded.sub,
      email: decoded.email,
      role: decoded.role,
    };

    next();
  } catch (err) {
    // Not a valid user token - treat as an unauthenticated request rather
    // than rejecting it.
    next();
  }
}

module.exports = optionalAuthMiddleware;
