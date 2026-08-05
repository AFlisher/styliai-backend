"use strict";

const { logger } = require("../../utils/logger");

/**
 * Sprint 2 / B-3 — Apple StoreKit 2 verification. PREPARED, NOT ACTIVE.
 *
 * ─── Why this file exists in this state ─────────────────────────────────────
 *
 * Completing Apple verification requires four values that only exist inside an
 * Apple Developer account: an App Store Connect API key (.p8), its key id, the
 * issuer id, and the app's bundle id as Apple records it. None can be derived
 * from this repository, and inventing them would produce code that looks
 * finished, passes review, and rejects every real purchase in production.
 *
 * So this implements everything that is knowable here - the interface, the
 * decode, the claim contract, the error taxonomy - and refuses with
 * `not_configured` until the credentials exist. `purchaseService` treats that
 * exactly as it treats a Google outage: PROVIDER_UNAVAILABLE, retryable, no
 * credits granted, no purchase consumed. An iOS build shipped before the
 * credentials land therefore fails safely and visibly rather than silently
 * crediting or silently swallowing purchases.
 *
 * ─── What is left to do, precisely ──────────────────────────────────────────
 *
 * 1. Create an App Store Connect API key with the "In-App Purchase" role.
 *    Set APPLE_IAP_KEY_ID, APPLE_IAP_ISSUER_ID, APPLE_IAP_PRIVATE_KEY (the .p8
 *    contents), APPLE_BUNDLE_ID.
 * 2. Implement `signAppStoreJwt()` below: ES256, header {alg, kid, typ:"JWT"},
 *    payload {iss: issuerId, iat, exp (<=60m), aud: "appstoreconnect-v1",
 *    bid: bundleId}. `jsonwebtoken` is already a dependency and supports ES256.
 * 3. Implement `fetchTransaction()`: GET
 *    https://api.storekit.itunes.apple.com/inApps/v1/transactions/{transactionId}
 *    (and .../sandbox for TestFlight), Authorization: Bearer <jwt>.
 * 4. Verify the returned JWS signature chain against Apple's root CA before
 *    trusting any field. THIS IS THE STEP THAT MATTERS - decoding a JWS
 *    payload without verifying its chain is not verification, and the decode
 *    helper below is deliberately named to make that impossible to forget.
 *
 * The rest of the pipeline - claim, grant, ledger - is already written and
 * platform-agnostic, so step 4 is the last thing between this and working iOS
 * purchases.
 */

const REQUIRED_ENV = [
  "APPLE_IAP_KEY_ID",
  "APPLE_IAP_ISSUER_ID",
  "APPLE_IAP_PRIVATE_KEY",
  "APPLE_BUNDLE_ID",
];

function isConfigured(env = process.env) {
  return REQUIRED_ENV.every((name) => env[name] && String(env[name]).trim());
}

/** Which of the four are still missing. Used by the readiness surface. */
function missingConfiguration(env = process.env) {
  return REQUIRED_ENV.filter((name) => !env[name] || !String(env[name]).trim());
}

/**
 * Decodes a JWS payload WITHOUT verifying its signature.
 *
 * Named unsafely on purpose. Apple's transaction payloads are JWS, and it is
 * trivially easy to base64-decode the middle segment, read `productId`, and
 * ship something that looks like verification while accepting any payload an
 * attacker types. This helper exists for logging and for tests; production
 * code must not grant on its output, which is why nothing in this module's
 * exported verification path calls it.
 */
function unsafeDecodeJwsPayload(jws) {
  if (typeof jws !== "string") return null;
  const parts = jws.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * The same contract as googlePlayVerifier.verifyPurchase, so purchaseService
 * needs no platform branch beyond selecting the verifier.
 *
 * @returns {Promise<{ok: true, productId, orderId, purchaseTimeMillis, acknowledged}
 *                  | {ok: false, reason: string, retryable: boolean}>}
 */
async function verifyPurchase({ productId, purchaseToken }, env = process.env) {
  if (!isConfigured(env)) {
    logger.warn("apple_verify_unconfigured", { missing: missingConfiguration(env) });
    return { ok: false, reason: "not_configured", retryable: true };
  }

  if (!purchaseToken || typeof purchaseToken !== "string") {
    return { ok: false, reason: "missing_purchase_token", retryable: false };
  }
  if (!productId || typeof productId !== "string") {
    return { ok: false, reason: "missing_product_id", retryable: false };
  }

  // Configured but unimplemented is its own state, and it must not masquerade
  // as either "valid" or "the buyer's fault". Setting the four variables
  // without finishing steps 2-4 above lands here.
  logger.error("apple_verify_not_implemented", {
    reason: "credentials_present_but_signature_verification_unimplemented",
  });
  return { ok: false, reason: "not_configured", retryable: true };
}

/**
 * Apple has no acknowledgement step - StoreKit 2 finishes transactions on the
 * device, and there is no three-day auto-refund window to race. Present so the
 * two verifiers share one shape; reporting success is correct, not a stub.
 */
async function acknowledgePurchase() {
  return { ok: true, reason: "not_applicable" };
}

module.exports = {
  verifyPurchase,
  acknowledgePurchase,
  isConfigured,
  missingConfiguration,
  unsafeDecodeJwsPayload,
  REQUIRED_ENV,
};
