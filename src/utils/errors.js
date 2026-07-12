const ErrorCodes = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  NOT_FOUND: "NOT_FOUND",
  FORBIDDEN: "FORBIDDEN",
  INSUFFICIENT_BALANCE: "INSUFFICIENT_BALANCE",
  PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
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
