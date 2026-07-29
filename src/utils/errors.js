const ErrorCodes = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  NOT_FOUND: "NOT_FOUND",
  FORBIDDEN: "FORBIDDEN",
  INSUFFICIENT_BALANCE: "INSUFFICIENT_BALANCE",
  PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
  RATE_LIMITED: "RATE_LIMITED",
  // SEC-0.5. Distinct from FORBIDDEN so clients and dashboards can tell a
  // device-integrity refusal from an authorization one; the message itself is
  // deliberately uniform across every integrity failure so it cannot be used
  // as an oracle.
  INTEGRITY_BLOCKED: "INTEGRITY_BLOCKED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
};

/**
 * Structured application error. Controllers throw/next() these so the global
 * error handler in app.js can build the HTTP response from `code`/`statusCode`
 * instead of each controller hand-rolling res.status().json() calls.
 */
class AppError extends Error {
  constructor(code, message, statusCode) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.isAppError = true;
  }
}

module.exports = { AppError, ErrorCodes };
