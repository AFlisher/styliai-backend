const jwt = require('jsonwebtoken');

function authMiddleware(req, res, next) {
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
    const secret = process.env.SUPABASE_JWT_SECRET;
    if (!secret) {
      throw new Error("SUPABASE_JWT_SECRET is not configured on the server.");
    }

    const decoded = jwt.verify(token, secret);
    // Supplying standard user payload
    req.user = {
      id: decoded.sub, // sub is user UUID in Supabase standard
      email: decoded.email,
      role: decoded.role
    };

    next();
  } catch (err) {
    console.error("JWT verification error:", err.message);
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
