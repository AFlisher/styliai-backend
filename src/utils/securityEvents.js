"use strict";

/**
 * Phase 5 — the security and audit event vocabulary.
 *
 * One function per category rather than a free-form `log(event, data)`, so the
 * field names stay consistent across call sites and an operator can write a
 * query once. Every one of these takes metadata only: there is deliberately no
 * parameter that accepts a request body, a header map or an error object, which
 * is what keeps credentials out by construction rather than by filtering.
 *
 * These complement, and do not replace, `admin_audit_log` (SEC-15.1). That
 * table is the durable accountability record for admin mutations, written
 * transactionally on the money path; these are log lines for operators. A log
 * stream can be lost or truncated, so the two are not interchangeable.
 */

const { logger } = require("./logger");
const metrics = require("./metrics");

/** Shared envelope: what request was this, and who was making it. */
function context(req) {
  if (!req) return {};
  return {
    requestId: req.id,
    method: req.method,
    endpoint: req.baseUrl ? `${req.baseUrl}${req.path}` : req.path,
    ip: req.ip,
    userId: (req.user && req.user.id) || undefined,
    adminId: (req.admin && req.admin.id) || undefined,
  };
}

/**
 * Authentication failed: a bad or absent credential.
 *
 * `reason` is a short fixed label chosen by the caller ("no_header",
 * "invalid_token", "wrong_password"), never the underlying error message - a
 * JWT library's text can name the algorithm or echo parts of the input, and a
 * password path's message is an oracle.
 */
function logAuthFailure(req, { reason, subject } = {}) {
  metrics.increment("auth_failures");
  logger.warn("auth_failure", { ...context(req), reason, subject });
}

/** Authenticated, but not permitted. Distinct from the above on purpose. */
function logAuthzFailure(req, { reason, required, actual } = {}) {
  metrics.increment("authz_failures");
  logger.warn("authz_failure", { ...context(req), reason, required, actual });
}

/**
 * A request was rejected for its shape or content.
 *
 * `field` names what was wrong; the offending VALUE is never logged - it is
 * user input, and for the auth routes it is a credential.
 */
function logValidationFailure(req, { code, field, reason } = {}) {
  metrics.increment("validation_failures");
  logger.info("validation_failure", { ...context(req), code, field, reason });
}

/** An upload was refused or could not be stored. */
function logUploadFailure(req, { stage, reason, bucket } = {}) {
  metrics.increment("upload_failures");
  logger.warn("upload_failure", { ...context(req), stage, reason, bucket });
}

/**
 * A notable, successful security-relevant action: login, logout, password
 * reset, email verification, avatar upload, profile update.
 *
 * Successes matter as much as failures here - "when did this account's password
 * last change" is unanswerable from failures alone.
 */
function logAuditEvent(req, { action, outcome = "success", subject, details } = {}) {
  metrics.increment(`audit_${action}`);
  logger.info("audit_event", { ...context(req), action, outcome, subject, details });
}

/**
 * An exception nobody expected.
 *
 * The message is kept because it is ours to read; the stack is kept at
 * `error.stack` only for genuinely unexpected failures, and never leaves the
 * server. SEC-7.3's rule applies: the error OBJECT is never spread or
 * serialised, because a provider SDK's error can carry the request that
 * produced it - including its headers.
 */
function logUnexpectedError(req, err, { where } = {}) {
  metrics.increment("unhandled_errors");
  logger.error("unhandled_error", {
    ...context(req),
    where,
    name: (err && err.name) || "Error",
    message: (err && err.message) || "unknown",
    stack: (err && typeof err.stack === "string" ? err.stack : "").split("\n").slice(0, 8).join("\n"),
  });
}

module.exports = {
  logAuthFailure,
  logAuthzFailure,
  logValidationFailure,
  logUploadFailure,
  logAuditEvent,
  logUnexpectedError,
};
