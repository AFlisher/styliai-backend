const { roleSatisfies, requiredRoleFor } = require("../config/adminRoutePolicy");
const { logAuthFailure, logAuthzFailure } = require("../utils/securityEvents");

/**
 * SEC-15.4: per-route authorization for the admin surface.
 *
 * Runs AFTER adminAuthMiddleware, which is what establishes that the caller is
 * an admin at all. The split is deliberate: `role: "admin"` in the JWT answers
 * "is this an admin token" (authentication), and the separate `adminRole` claim
 * answers "how much may it do" (authorization). One claim answering both
 * questions is how those two concerns get conflated, and conflating them is
 * what made least privilege unexpressible before this.
 *
 * Denials are 403, never 401. The dashboard's apiCall fires its global logout
 * interceptor on any 401, so answering 401 here would sign a viewer out for
 * touching a button they simply aren't allowed to use.
 */
function requireAdminRole(required) {
  return function adminRoleGuard(req, res, next) {
    // Defensive: adminAuthMiddleware always runs first and would have rejected
    // the request. If that ordering is ever broken, refuse rather than read a
    // role off an unauthenticated request.
    if (!req.admin) {
      logAuthFailure(req, { reason: "admin_guard_without_auth" });
      return res.status(401).json({ message: "Admin authentication required." });
    }

    // Taken only from the verified JWT (adminAuthMiddleware sets it). Never
    // from the body, a header or the query string.
    if (!roleSatisfies(req.admin.adminRole, required)) {
      // Role names are ours, not user input, so both are safe to record - and
      // "who tried to do what they could not" is the whole point of the event.
      logAuthzFailure(req, { reason: "insufficient_role", required, actual: req.admin.adminRole });
      return res.status(403).json({
        code: "INSUFFICIENT_ROLE",
        message: "Your admin role does not permit this action.",
      });
    }

    return next();
  };
}

/**
 * Builds the guard for a route by looking its required role up in
 * ADMIN_ROUTE_POLICY - the form the route files use, so the policy table stays
 * the single source of truth and no route file hard-codes a tier.
 *
 * Throws at module load (i.e. at server startup) if the route has no policy
 * entry, so an admin route added without a tier is a boot failure rather than
 * an unguarded endpoint.
 *
 * @param {string} routeKey e.g. `"DELETE /api/styles/:id"`
 */
function requireAdminRoleFor(routeKey) {
  return requireAdminRole(requiredRoleFor(routeKey));
}

module.exports = { requireAdminRole, requireAdminRoleFor };
