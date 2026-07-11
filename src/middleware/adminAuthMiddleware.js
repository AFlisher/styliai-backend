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

module.exports = adminAuthMiddleware;
