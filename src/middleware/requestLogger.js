"use strict";

/**
 * Phase 5 — one structured line per completed request, and the metrics that go
 * with it.
 *
 * This replaces `morgan("dev")`. Two reasons, both operational: the coloured
 * `dev` format is not machine-readable, so none of it could be queried or
 * alerted on; and it carried no correlation id, no duration in a parseable
 * field, and no identity, so a line could not be joined to anything else.
 *
 * SEC-16.1's protection is preserved and, if anything, strengthened. The URL is
 * still passed through `redactUrl`, so verification and reset tokens never
 * reach the stream - and it now happens in one place that every log line goes
 * through, rather than in a format token that only applied to morgan.
 */

const { logger } = require("../utils/logger");
const metrics = require("../utils/metrics");
const { redactUrl } = require("../utils/redactUrl");
const { elapsedMs } = require("./requestContext");

/** Bounded: a user agent is attacker-controlled and can be arbitrarily long. */
const MAX_USER_AGENT = 200;

function requestLogger(req, res, next) {
  // `finish` fires when the response has been handed to the OS. Like the audit
  // hook (SEC-15.1), this runs outside Express's error pipeline, so a throw
  // here would be an uncaught exception rather than a failed request - hence
  // the total handler.
  res.on("finish", () => {
    try {
      const durationMs = elapsedMs(req);

      metrics.recordRequest({ status: res.statusCode, durationMs });

      const ua = req.get("user-agent");

      logger.info("http_request", {
        requestId: req.id,
        method: req.method,
        // Redacted, always. `originalUrl` is where an account-recovery token
        // would appear.
        path: redactUrl(req.originalUrl || req.url),
        status: res.statusCode,
        durationMs: durationMs === null ? null : Number(durationMs.toFixed(1)),
        // Identity when the request carried one. authMiddleware sets req.user,
        // adminAuthMiddleware sets req.admin; anonymous requests log neither.
        userId: (req.user && req.user.id) || undefined,
        adminId: (req.admin && req.admin.id) || undefined,
        ip: req.ip,
        userAgent: ua ? ua.slice(0, MAX_USER_AGENT) : undefined,
      });
    } catch (_) {
      /* never let logging break a completed response */
    }
  });

  next();
}

module.exports = requestLogger;
