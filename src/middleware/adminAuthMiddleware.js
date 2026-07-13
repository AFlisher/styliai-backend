const jwt = require('jsonwebtoken');

function adminAuthMiddleware(req, res, next) {
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

    const decoded = jwt.verify(token, secret);

    if (decoded.role !== 'admin') {
      return res.status(403).json({ message: "Admin privileges required." });
    }

    req.admin = {
      id: decoded.sub,
      email: decoded.email,
      role: decoded.role
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
function optionalAdminAuth(req, res, next) {
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

    const decoded = jwt.verify(token, secret);

    if (decoded.role === 'admin') {
      req.admin = {
        id: decoded.sub,
        email: decoded.email,
        role: decoded.role
      };
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
