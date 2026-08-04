const { z } = require("zod");
const { AppError, ErrorCodes } = require("../utils/errors");

/**
 * SEC-9.1 - shared request-shape validation.
 *
 * WHY THIS EXISTS
 * ---------------
 * Several handlers passed route params and body fields straight to Postgres
 * and let the column types do the validating. That fails CLOSED - the
 * operation is always rejected, and Section 9 of the audit confirmed there is
 * no bypass or injection path here - but it fails closed with the wrong status
 * code and an inconsistent one: `DELETE /api/creations/not-a-uuid` produced a
 * Postgres 22P02 surfaced as 500, while notificationController had hand-rolled
 * a 22P02 -> 404 mapping for the same class of input.
 *
 * The problem with leaning on the database for this is not that today's
 * behaviour is unsafe, it is that the safety is incidental. It holds only as
 * long as every column stays strictly typed and every handler happens to be
 * hit by a query that type-checks the value before doing anything with it.
 * Validating at the edge makes the guarantee explicit and independent of the
 * schema, and it stops a malformed id from consuming a database round-trip
 * (and, now that SEC-19.3 sets one, a connection with a statement timeout) to
 * learn what a regex could have decided for free.
 *
 * ATTACK PREVENTED
 * ----------------
 * No authentication or authorization bypass - there was none to prevent. What
 * this closes is (a) unauthenticated/cheap error-path amplification: malformed
 * ids no longer reach the pool at all, so they cannot be used to occupy
 * connections; and (b) the 500-as-a-signal problem, where a client-caused
 * refusal was indistinguishable from a genuine server fault in logs and
 * alerting, which is what makes a real 500 easy to miss.
 *
 * COMPATIBILITY
 * -------------
 * A request that was previously rejected with 500 is now rejected with 400.
 * No request that previously SUCCEEDED changes behaviour: every value these
 * validators accept is a superset of what the database would have accepted,
 * because a value that fails a UUID check could never have satisfied a `uuid`
 * column either. This is a status-code change on an already-failing path.
 */

// Accepts any RFC 4122 variant, matching what Postgres' own `uuid` type
// accepts, so this can never reject an id the database would have taken.
// z.uuid() is deliberately not used: it is stricter about the version nibble
// than Postgres is, which would make this validator reject ids the database
// considers valid - a validator that is tighter than the storage it guards is
// a source of future 400s on legitimate data.
const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function isUuid(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/**
 * Rejects a request whose named route params are not well-formed UUIDs.
 *
 * The message names the offending parameter but never echoes its value: the
 * value is attacker-controlled, and reflecting it verbatim into a response
 * body is how a validation message becomes a reflection gadget.
 */
function uuidParams(...names) {
  return function validateUuidParams(req, _res, next) {
    for (const name of names) {
      if (!isUuid(req.params[name])) {
        return next(
          new AppError(
            ErrorCodes.VALIDATION_ERROR,
            `${name} must be a valid UUID.`,
            400
          )
        );
      }
    }
    return next();
  };
}

/**
 * Validates req.body against a Zod schema, replacing it with the parsed
 * result so downstream handlers see coerced, bounded values rather than raw
 * input.
 *
 * Only the first issue is reported. Returning the full issue list would
 * describe the schema to a caller field by field, and none of the clients
 * render more than one message anyway.
 */
function validateBody(schema) {
  return function validateRequestBody(req, _res, next) {
    const result = schema.safeParse(req.body ?? {});
    if (!result.success) {
      const issue = result.error.issues[0];
      const path = issue.path.join(".");
      return next(
        new AppError(
          ErrorCodes.VALIDATION_ERROR,
          path ? `${path}: ${issue.message}` : issue.message,
          400
        )
      );
    }
    req.body = result.data;
    return next();
  };
}

/**
 * Postgres error codes that are caused by the request, not by the server.
 *
 * These are mapped centrally in app.js's error handler rather than in each
 * controller's catch block, which is how they came to be handled three
 * different ways. Anything not listed here keeps its existing behaviour and
 * still becomes a 500 - this is a deliberate allowlist, so a genuine server
 * fault is never quietly relabelled as the caller's fault.
 */
const PG_CLIENT_ERROR_CODES = {
  // invalid_text_representation - e.g. a malformed UUID that got past (or
  // around) the validators above. Kept as a backstop even though the
  // validators exist: defence in depth is the point, and a route added later
  // without a validator should still not answer 500.
  "22P02": { status: 400, message: "One or more parameters are malformed." },
  // numeric_value_out_of_range
  "22003": { status: 400, message: "A numeric value is out of range." },
  // invalid_datetime_format
  "22007": { status: 400, message: "A date or time value is malformed." },
  // datetime_field_overflow
  "22008": { status: 400, message: "A date or time value is out of range." },
  // program_limit_exceeded - e.g. an index-key-too-large on an oversized value
  "54000": { status: 400, message: "A value in the request is too large." },
};

/**
 * SEC-19.3 interaction: `57014` is query_canceled, which is what Postgres
 * raises when the statement_timeout that finding introduced actually fires.
 * Before SEC-19.3 no query could time out, so this code was unreachable and
 * nothing mapped it. Left unmapped it would surface as a 500, i.e. the new
 * safety mechanism would look like a server bug the first time it did its
 * job. It is a 503 with a retry hint instead: the request is well-formed and
 * the server is the thing that could not answer in time.
 */
const PG_QUERY_CANCELED = "57014";

/**
 * Translates a body-parser or Postgres error into an AppError, or returns
 * null if the error is not one of these (in which case the caller keeps its
 * existing 500 behaviour).
 *
 * Exported and pure so the mapping can be asserted directly in tests without
 * standing up a request.
 */
function toClientError(err) {
  if (!err) return null;

  // ---- express.json() / body-parser -------------------------------------
  // These arrive as errors with a `type` set by body-parser and a `status`
  // it already chose; the codes below restate that intent in this API's own
  // {code, message} vocabulary rather than letting body-parser's default HTML
  // error handler or the generic 500 branch answer.
  switch (err.type) {
    case "entity.parse.failed":
      // SEC-9.1's named case: malformed JSON was a 500. The parse error's own
      // message can quote a fragment of the offending body, so a fixed
      // sentence is returned instead of err.message.
      return new AppError(
        ErrorCodes.VALIDATION_ERROR,
        "Request body is not valid JSON.",
        400
      );
    case "entity.too.large":
      // SEC-9.4's limit firing. 413 is the honest code and clients can act on
      // it; a 400 here would tell a client to fix its syntax when the syntax
      // was fine.
      return new AppError(
        ErrorCodes.VALIDATION_ERROR,
        "Request body is too large.",
        413
      );
    case "encoding.unsupported":
      return new AppError(
        ErrorCodes.VALIDATION_ERROR,
        "Unsupported content encoding.",
        415
      );
    case "request.aborted":
      // The client hung up mid-body. Not our fault and not worth a 500 in the
      // error stream; 400 records it as a client-side outcome.
      return new AppError(
        ErrorCodes.VALIDATION_ERROR,
        "Request aborted.",
        400
      );
    default:
      break;
  }

  // ---- Postgres ---------------------------------------------------------
  if (typeof err.code === "string") {
    if (err.code === PG_QUERY_CANCELED) {
      return new AppError(
        ErrorCodes.PROVIDER_UNAVAILABLE,
        "The request took too long to process. Please try again.",
        503
      );
    }

    const mapped = PG_CLIENT_ERROR_CODES[err.code];
    if (mapped) {
      return new AppError(ErrorCodes.VALIDATION_ERROR, mapped.message, mapped.status);
    }
  }

  return null;
}

module.exports = {
  uuidParams,
  validateBody,
  toClientError,
  isUuid,
  UUID_PATTERN,
  PG_CLIENT_ERROR_CODES,
  PG_QUERY_CANCELED,
  z,
};
