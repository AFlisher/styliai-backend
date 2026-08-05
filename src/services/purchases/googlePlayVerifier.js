"use strict";

const { JWT } = require("google-auth-library");
const { logger } = require("../../utils/logger");

/**
 * Sprint 2 / B-3 — Google Play purchase verification.
 *
 * Talks to the Android Publisher REST API directly with a service-account JWT
 * rather than pulling in `googleapis`. That package is tens of megabytes for
 * two endpoints, and `google-auth-library` - already a dependency for Google
 * Sign-In - is the only part of it this needs. Node's global `fetch` does the
 * rest.
 *
 * ─── What "verified" means here ─────────────────────────────────────────────
 *
 * The client sends a purchase token. This asks GOOGLE what that token is worth,
 * and believes only the answer. Nothing the client says about the product, the
 * price, or the credits is read - the product id is taken from Google's
 * response, not from the request body, so a client that claims a 100-credit
 * pack while presenting a 10-credit token gets 10 credits.
 *
 * ─── Fail closed, and loudly ────────────────────────────────────────────────
 *
 * Every failure path returns `ok: false` with a reason. There is deliberately
 * no "assume valid when the API is unreachable" branch: an outage at Google
 * must stop purchases being credited, not start crediting them for free. The
 * client is told to retry, and the purchase token remains valid on the device
 * until it is, so nothing is lost by refusing.
 */

const ANDROID_PUBLISHER_SCOPE = "https://www.googleapis.com/auth/androidpublisher";

/** Google's own purchaseState values for a one-time product. */
const PURCHASE_STATE_PURCHASED = 0;
const PURCHASE_STATE_CANCELLED = 1;
const PURCHASE_STATE_PENDING = 2;

/** A purchase already consumed on Google's side cannot be redeemed again. */
const CONSUMPTION_STATE_CONSUMED = 1;

/**
 * How long to wait on Google. A purchase verification sits in front of a user
 * staring at a spinner, and the pool-level statement timeout does not apply to
 * an outbound HTTP call.
 */
const VERIFY_TIMEOUT_MS = Number(process.env.PLAY_VERIFY_TIMEOUT_MS) || 10_000;

/**
 * Builds the authorised client. Returns null when unconfigured, which callers
 * surface as PROVIDER_UNAVAILABLE rather than as a rejected purchase - an
 * operator who has not finished the Play setup must not see users' valid
 * purchases refused as fraudulent.
 *
 * The credential is a service-account JSON, supplied whole as an env var
 * because Railway has no file mounts. It is parsed once per call rather than
 * cached at module load so that rotating it is a restart, not a redeploy, and
 * so that merely importing this module never throws on a malformed value.
 */
function buildClient(env = process.env) {
  const raw = env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
  if (!raw || !String(raw).trim()) return null;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // Deliberately does not echo the value: it is a private key.
    logger.error("play_verifier_config_invalid", { reason: "service_account_json_unparseable" });
    return null;
  }

  if (!parsed.client_email || !parsed.private_key) {
    logger.error("play_verifier_config_invalid", { reason: "service_account_missing_fields" });
    return null;
  }

  return new JWT({
    email: parsed.client_email,
    key: parsed.private_key,
    scopes: [ANDROID_PUBLISHER_SCOPE],
  });
}

function isConfigured(env = process.env) {
  return Boolean(
    env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON &&
      String(env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON).trim() &&
      env.ANDROID_PACKAGE_NAME &&
      String(env.ANDROID_PACKAGE_NAME).trim()
  );
}

/**
 * Verifies a one-time product purchase.
 *
 * @returns {Promise<{ok: true, productId, orderId, purchaseTimeMillis, acknowledged}
 *                  | {ok: false, reason: string, retryable: boolean}>}
 */
async function verifyPurchase({ productId, purchaseToken }, env = process.env) {
  if (!isConfigured(env)) {
    return { ok: false, reason: "not_configured", retryable: true };
  }
  if (!purchaseToken || typeof purchaseToken !== "string") {
    return { ok: false, reason: "missing_purchase_token", retryable: false };
  }
  if (!productId || typeof productId !== "string") {
    return { ok: false, reason: "missing_product_id", retryable: false };
  }

  const client = buildClient(env);
  if (!client) return { ok: false, reason: "not_configured", retryable: true };

  const packageName = String(env.ANDROID_PACKAGE_NAME).trim();

  // The productId goes into the URL because Google's endpoint is keyed by it.
  // That does NOT make it trusted input: a token presented against the wrong
  // product returns 404 rather than a valid purchase, and the caller compares
  // the response's own productId before granting anything.
  const url =
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/` +
    `${encodeURIComponent(packageName)}/purchases/products/` +
    `${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}`;

  let response;
  try {
    response = await client.request({ url, method: "GET", timeout: VERIFY_TIMEOUT_MS });
  } catch (err) {
    const status = err && err.response && err.response.status;

    // 404 = Google does not know this token for this product. That is a
    // definitive "no", not a transport failure, so it must not be retried
    // forever by a client that thinks it owns a purchase.
    if (status === 404 || status === 400) {
      logger.warn("play_verify_rejected", { status, reason: "unknown_token" });
      return { ok: false, reason: "purchase_not_found", retryable: false };
    }

    // 401/403 mean OUR credentials are wrong, which is an operator problem and
    // must never present as the buyer's purchase being invalid.
    if (status === 401 || status === 403) {
      logger.error("play_verify_unauthorized", { status });
      return { ok: false, reason: "verifier_unauthorized", retryable: true };
    }

    logger.error("play_verify_failed", {
      status: status || null,
      // Message only, never the error object - it can carry request headers.
      error: (err && err.message) || "unknown",
    });
    return { ok: false, reason: "verification_unavailable", retryable: true };
  }

  const data = (response && response.data) || {};

  if (data.purchaseState === PURCHASE_STATE_PENDING) {
    // A pending purchase (e.g. cash payment in some markets) is not money yet.
    return { ok: false, reason: "purchase_pending", retryable: true };
  }
  if (data.purchaseState === PURCHASE_STATE_CANCELLED) {
    return { ok: false, reason: "purchase_cancelled", retryable: false };
  }
  if (data.purchaseState !== PURCHASE_STATE_PURCHASED) {
    return { ok: false, reason: "purchase_not_completed", retryable: false };
  }

  // Already consumed on Google's side means this token was redeemed before.
  // Our own processed_purchases claim is the primary guard; this is the
  // second, and it catches the case where our row was lost but Google's
  // record was not.
  if (data.consumptionState === CONSUMPTION_STATE_CONSUMED) {
    return { ok: false, reason: "already_consumed", retryable: false };
  }

  return {
    ok: true,
    // From Google's response, never from the request.
    productId: data.productId || productId,
    orderId: data.orderId || null,
    purchaseTimeMillis: data.purchaseTimeMillis || null,
    acknowledged: data.acknowledgementState === 1,
  };
}

/**
 * Acknowledges a purchase. Google auto-refunds anything unacknowledged after
 * three days, so this is not optional bookkeeping - skipping it silently
 * reverses the sale days later.
 *
 * Separated from verification because it must run only after the credits are
 * committed: acknowledging first and then failing to grant would tell Google
 * the buyer was served when they were not.
 */
async function acknowledgePurchase({ productId, purchaseToken }, env = process.env) {
  if (!isConfigured(env)) return { ok: false, reason: "not_configured" };

  const client = buildClient(env);
  if (!client) return { ok: false, reason: "not_configured" };

  const packageName = String(env.ANDROID_PACKAGE_NAME).trim();
  const url =
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/` +
    `${encodeURIComponent(packageName)}/purchases/products/` +
    `${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`;

  try {
    await client.request({ url, method: "POST", timeout: VERIFY_TIMEOUT_MS, data: {} });
    return { ok: true };
  } catch (err) {
    const status = err && err.response && err.response.status;
    logger.error("play_acknowledge_failed", {
      status: status || null,
      error: (err && err.message) || "unknown",
    });
    return { ok: false, reason: "acknowledge_failed" };
  }
}

module.exports = {
  verifyPurchase,
  acknowledgePurchase,
  isConfigured,
  buildClient,
  PURCHASE_STATE_PURCHASED,
  PURCHASE_STATE_CANCELLED,
  PURCHASE_STATE_PENDING,
  CONSUMPTION_STATE_CONSUMED,
};
