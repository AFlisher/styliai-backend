/**
 * SEC-16.1: strip credential values out of request URLs before they are
 * logged.
 *
 * The email-verification and password-reset flows deliver their secret in the
 * query string (`/api/auth/verify?token=...`, `/api/auth/reset-password?token=...`),
 * and morgan's `:url` token is `req.originalUrl` verbatim - so every click on a
 * recovery link wrote a live, single-use account-takeover secret to stdout.
 * The database deliberately stores only a SHA-256 hash of those tokens, which
 * meant the log held a *stronger* form of the secret than the database did.
 *
 * What this deliberately preserves, because the log still has to be useful:
 * the path, the parameter *names*, and every non-credential value byte for
 * byte. Keeping the `token=` key visible is intentional - the endpoints answer
 * differently for "token present but wrong" and "token missing", and that
 * distinction is worth keeping in the log.
 *
 * This does NOT take tokens out of URLs (they still reach browser history and
 * any upstream proxy's own access log); it only stops this application from
 * writing them. Moving the secret out of the query string is a separate,
 * larger change - see the audit's SEC-16.1 recommendation (2).
 */

const REDACTION_PLACEHOLDER = "[REDACTED]";

// Matched EXACTLY (case-insensitively) against the query parameter name, never
// as a substring - `?tokenizer=x` is not a credential and stays readable.
// Values are never inspected: whether something is a secret is decided by the
// name it was sent under, so no amount of crafted input can talk its way past.
//
// Email addresses are knowingly NOT in this set: that exposure is tracked
// separately as SEC-16.2 and is a one-line addition here when it is taken up.
const REDACTED_QUERY_PARAMS = new Set(["token"]);

/**
 * Returns `url` with the value of any credential-bearing query parameter
 * replaced by a fixed placeholder.
 *
 * This function must never throw. morgan invokes its format tokens from an
 * `onFinished(res, ...)` callback, which sits outside Express's request and
 * error pipelines - an exception raised there is an uncaught exception that
 * takes down the process, not a 500 on one request. Hence the total-function
 * contract and the fail-closed catch below.
 *
 * @param {string} url e.g. `/api/auth/verify?token=abc&foo=1`
 * @returns {string}   e.g. `/api/auth/verify?token=[REDACTED]&foo=1`
 */
function redactUrl(url) {
  try {
    if (typeof url !== "string" || url === "") {
      return "";
    }

    const queryStart = url.indexOf("?");
    if (queryStart === -1) {
      return url;
    }

    const path = url.slice(0, queryStart);
    const query = url.slice(queryStart + 1);

    // Split manually rather than via URLSearchParams: that would re-encode and
    // normalise every value, so untouched parameters would no longer match
    // what the client actually sent - which is exactly what makes a request
    // log worth reading.
    const redactedQuery = query
      .split("&")
      .map((pair) => {
        const separator = pair.indexOf("=");
        if (separator === -1) {
          // A valueless parameter (`?token`) carries no secret to remove.
          return pair;
        }

        const name = pair.slice(0, separator);

        // Normalise only for the lookup - the original name is what gets
        // emitted, so well-formed URLs are unchanged. A malformed query like
        // `/x??token=secret` yields the name "?token", which would otherwise
        // slip past exact matching and log the value verbatim. Express parses
        // that as a parameter literally named "?token" (so `req.query.token`
        // is undefined and no real recovery link can take this shape), but the
        // logger must not depend on that to stay safe.
        const lookupName = name.trim().replace(/^\?+/, "").toLowerCase();
        if (!REDACTED_QUERY_PARAMS.has(lookupName)) {
          return pair;
        }

        return `${name}=${REDACTION_PLACEHOLDER}`;
      })
      .join("&");

    return `${path}?${redactedQuery}`;
  } catch (err) {
    // Fail closed. If anything above ever surprises us, drop the whole query
    // string rather than fall back to the raw URL - a fail-open catch here
    // would hand back the secret under precisely the malformed input an
    // attacker controls.
    try {
      return typeof url === "string" ? url.split("?")[0] : "";
    } catch (_) {
      return "";
    }
  }
}

module.exports = {
  redactUrl,
  REDACTED_QUERY_PARAMS,
  REDACTION_PLACEHOLDER,
};
