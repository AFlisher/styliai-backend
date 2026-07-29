const crypto = require("crypto");
const { GoogleAuth } = require("google-auth-library");
const { config } = require("../config/playIntegrityConfig");

/**
 * SEC-0.2 — the one place that talks to Google.
 *
 * Decoding happens on Google's servers, not ours: the token is encrypted with
 * keys we do not hold, which is exactly why a verdict means anything. We POST
 * the opaque token and read back a plain-text payload.
 *
 *   POST https://playintegrity.googleapis.com/v1/{packageName}:decodeIntegrityToken
 *   Authorization: Bearer <service account, scope `playintegrity`>
 *   { "integrity_token": "<token>" }
 *
 * This module deliberately does not decide anything about the payload it gets
 * back. It returns the verdict or a reason it could not; validation lives in
 * verifyIntegrity, and policy lives in SEC-0.5.
 */

const SCOPE = "https://www.googleapis.com/auth/playintegrity";
const ENDPOINT_BASE = "https://playintegrity.googleapis.com/v1";

let authClientPromise = null;

/**
 * Lazy, and cached across calls: GoogleAuth handles access-token refresh
 * internally, so building this per request would throw away that cache and add
 * a token exchange to every decode.
 */
function getAuth() {
  if (!authClientPromise) {
    authClientPromise = Promise.resolve(new GoogleAuth({ scopes: [SCOPE] }));
  }
  return authClientPromise;
}

/** SHA-256 of the token, hex. The only form of the token that is ever stored or logged. */
function hashToken(token) {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Decodes one token.
 *
 * Resolves to { ok: true, verdict } or { ok: false, unavailable, detail }.
 * `unavailable: true` means the failure was ours or Google's - a timeout, a
 * 5xx, a credential problem - and must never be conflated with a token that
 * Google actively rejected. SEC-0.5 has to be able to fail closed on an
 * attacker while staying open during a Google outage, and it can only do that
 * if this distinction survives the trip up the stack.
 */
async function decodeToken(token) {
  if (!config.packageName) {
    return { ok: false, unavailable: true, detail: "package_name_not_configured" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.decodeTimeoutMs);

  try {
    const auth = await getAuth();
    const accessToken = await auth.getAccessToken();
    if (!accessToken) {
      return { ok: false, unavailable: true, detail: "no_access_token" };
    }

    const url = `${ENDPOINT_BASE}/${encodeURIComponent(config.packageName)}:decodeIntegrityToken`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ integrity_token: token }),
      signal: controller.signal,
    });

    if (!response.ok) {
      // 4xx is Google telling us the token is bad; 5xx and 429 are Google
      // being unavailable. Only the first is attacker-attributable.
      const retryable = response.status >= 500 || response.status === 429;
      return {
        ok: false,
        unavailable: retryable,
        detail: `http_${response.status}`,
      };
    }

    const body = await response.json();
    const verdict = body && body.tokenPayloadExternal;
    if (!verdict) {
      return { ok: false, unavailable: false, detail: "missing_payload" };
    }

    return { ok: true, verdict };
  } catch (err) {
    const aborted = err && (err.name === "AbortError" || err.name === "TimeoutError");
    // Never leak the token: `err` here can only describe transport, but the
    // caller logs `detail`, so keep it to a short classification.
    return {
      ok: false,
      unavailable: true,
      detail: aborted ? "timeout" : "transport_error",
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Test seam: GoogleAuth is constructed once and cached for the process. */
function resetAuthForTest() {
  authClientPromise = null;
}

module.exports = { decodeToken, hashToken, resetAuthForTest, SCOPE };
