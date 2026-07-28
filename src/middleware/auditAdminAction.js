const adminAuditModel = require("../models/adminAuditModel");
const { redactUrl } = require("../utils/redactUrl");

/**
 * SEC-15.1: writes one admin_audit_log row per successful privileged mutation.
 *
 * Mounted ONCE, globally, ahead of the routers (see app.js) rather than being
 * attached to each admin route. That is the whole point of the design: with a
 * single insertion point it cannot miss an endpoint, including endpoints added
 * later, whereas nineteen per-route registrations would be nineteen chances to
 * forget one. It self-gates instead:
 *
 *   - `req.admin` must be set. Only adminAuthMiddleware and optionalAdminAuth
 *     set it, and only after verifying the JWT - so identity is never taken
 *     from a request body or header, and unauthenticated traffic is never
 *     recorded. POST /api/admin/login is therefore excluded by construction:
 *     it runs before any admin identity exists, so its body (which carries a
 *     password) can never reach this table.
 *   - the method must be mutating. GET /api/styles and GET /api/categories run
 *     optionalAdminAuth and so do set `req.admin`, but reads are not audited.
 *   - the response must be 2xx. A rejected request writes nothing, so an
 *     attacker cannot flood the table by hammering a route with a bad token.
 *
 * Failure semantics here are deliberately FAIL-OPEN: the mutation has already
 * committed by the time the response finishes, so refusing to serve it is not
 * an option, and refusing future ones because the audit table is unreachable
 * would turn an accountability gap into an availability outage. The money path
 * is the opposite - see walletService, where the audit row is written inside
 * the balance transaction and takes it down with it on failure. Handlers that
 * take that route set `req.auditWritten` so they are not recorded twice.
 */

const AUDITED_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Route-shaped action name, e.g. `DELETE /api/styles/:id`, so that "everything
 * this admin deleted" is one indexed query rather than a LIKE over ids.
 */
function describeAction(req) {
  const routePath = req.route && req.route.path;
  if (typeof routePath === "string") {
    return `${req.method} ${req.baseUrl || ""}${routePath === "/" ? "" : routePath}`;
  }
  // No matched route layer (shouldn't happen on a 2xx) - fall back to the
  // redacted URL rather than losing the record.
  return `${req.method} ${redactUrl(req.originalUrl || req.url)}`;
}

/** `/api/credit-packs` -> `credit-packs`. */
function describeTargetType(req) {
  const base = req.baseUrl || "";
  const segments = base.split("/").filter(Boolean);
  return segments.length ? segments[segments.length - 1] : null;
}

function emptyToNull(value) {
  if (value === null || typeof value !== "object") return value ?? null;
  if (Array.isArray(value)) return value.length ? value : null;
  return Object.keys(value).length ? value : null;
}

function auditAdminAction(req, res, next) {
  // Reads are the overwhelming majority of traffic (the whole mobile catalog
  // comes through here), and none of them are auditable - so skip before
  // attaching a listener rather than attaching one and discarding its result.
  // `req.admin` cannot be checked this early: it is set later, by the route's
  // own auth middleware.
  if (!AUDITED_METHODS.has(req.method)) {
    return next();
  }

  res.on("finish", () => {
    // Everything below runs on the 'finish' event, outside Express's error
    // pipeline. A synchronous throw or an unhandled rejection here is an
    // uncaught exception that kills the process, not a 500 on one request -
    // the same hazard morgan's token invocation has (see utils/redactUrl.js).
    // Hence the blanket try/catch and the .catch() on the insert.
    try {
      if (!req.admin || !req.admin.id) return;
      if (!AUDITED_METHODS.has(req.method)) return;
      if (res.statusCode < 200 || res.statusCode >= 300) return;
      // Already recorded transactionally by the handler (money path).
      if (req.auditWritten) return;

      adminAuditModel
        .record({
          adminId: req.admin.id,
          adminEmail: req.admin.email,
          action: describeAction(req),
          targetType: describeTargetType(req),
          targetId: req.params && req.params.id ? String(req.params.id) : null,
          // Destructive handlers hand back the row they removed (their models
          // use RETURNING *), which is what makes the deletion recoverable.
          before: emptyToNull(req.auditBefore),
          // The admin's submitted payload. For creates and updates this is the
          // intended after-state. Updates do NOT capture a before-state: that
          // would need a read of every row prior to every write, which this
          // finding does not justify - the submitted change plus the timestamp
          // is enough to attribute and review it.
          after: emptyToNull(req.body),
          ip: req.ip || null,
          // Redacted via SEC-16.1's utility: GET /api/admin/users/search is not
          // audited, but any future credential-bearing query string is covered
          // by the same rule the request log already follows.
          requestUrl: redactUrl(req.originalUrl || req.url),
          statusCode: res.statusCode,
        })
        .catch((err) => {
          console.error(
            `[audit] failed to record admin action ${req.method} ${req.originalUrl}:`,
            err.message
          );
        });
    } catch (err) {
      console.error("[audit] unexpected failure recording admin action:", err && err.message);
    }
  });

  next();
}

module.exports = auditAdminAction;
