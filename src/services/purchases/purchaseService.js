"use strict";

const db = require("../../config/db");
const walletService = require("../wallet/walletService");
const googlePlayVerifier = require("./googlePlayVerifier");
const appleVerifier = require("./appleVerifier");
const { logger } = require("../../utils/logger");

/**
 * Sprint 2 / B-3 — the platform-agnostic purchase pipeline.
 *
 * ─── Order of operations, and why it is this one ────────────────────────────
 *
 *   1. VERIFY with the platform.      Nothing the client says is believed.
 *   2. RESOLVE the product server-side. Credits come from our catalogue,
 *                                       never from the request.
 *   3. CLAIM the purchase id.          A PRIMARY KEY insert. This is the
 *                                       replay guard, and it runs BEFORE the
 *                                       grant so two concurrent redemptions
 *                                       resolve in Postgres, not in JS.
 *   4. GRANT the credits.              Rolls the claim back if it fails, so a
 *                                       failed grant does not burn the token.
 *   5. ACKNOWLEDGE to the platform.    Last, because acknowledging a purchase
 *                                       we then failed to credit tells Google
 *                                       the buyer was served when they were not.
 *
 * Steps 3 and 4 are the pair that matters. The alternative - grant, then
 * record - double-credits under concurrency, which is precisely the class of
 * bug the ad-reward path (walletController) already solved this way.
 *
 * ─── What the client is allowed to influence ────────────────────────────────
 *
 * Exactly two things: the platform, and the opaque purchase token. The product
 * id is read back from the PLATFORM'S response, and the credit amount is read
 * from OUR credit_packs table. A client claiming a 100-credit pack while
 * presenting a 10-credit token receives 10 credits.
 */

const VERIFIERS = {
  google: googlePlayVerifier,
  apple: appleVerifier,
};

/** Reasons that mean "this will never succeed", so the client should stop. */
const TERMINAL_REASONS = new Set([
  "purchase_not_found",
  "purchase_cancelled",
  "purchase_not_completed",
  "already_consumed",
  "missing_purchase_token",
  "missing_product_id",
  "unknown_product",
]);

function verifierFor(platform) {
  return VERIFIERS[platform] || null;
}

/**
 * Resolves a store SKU to an enabled credit pack.
 *
 * An unmatched product id is refused rather than defaulted. credit_packs.
 * product_id is NULL for every seeded pack until an operator sets it from the
 * store console (see migration_purchases.sql), so "no match" is the expected
 * state before that work is done - and granting a guessed amount in that state
 * would be worse than refusing.
 */
async function resolvePack(productId) {
  const { rows } = await db.query(
    `SELECT id, name, credits, product_id AS "productId"
       FROM credit_packs
      WHERE product_id = $1 AND is_enabled = true`,
    [productId]
  );
  return rows[0] || null;
}

/**
 * Redeems one purchase. Idempotent by construction: a purchase id already in
 * processed_purchases returns `alreadyRedeemed` without granting again, which
 * is what makes the client's restore flow and its retry safe.
 *
 * @returns {Promise<{granted: boolean, alreadyRedeemed?: boolean, credits?: number,
 *                    balance?: number, reason?: string, retryable?: boolean}>}
 */
async function redeemPurchase({ userId, platform, productId, purchaseToken }) {
  const verifier = verifierFor(platform);
  if (!verifier) {
    return { granted: false, reason: "unsupported_platform", retryable: false };
  }

  // 1. Ask the platform. Never the client.
  const verified = await verifier.verifyPurchase({ productId, purchaseToken });
  if (!verified.ok) {
    logger.warn("purchase_verification_failed", {
      userId,
      platform,
      reason: verified.reason,
      retryable: verified.retryable,
    });
    return {
      granted: false,
      reason: verified.reason,
      retryable: verified.retryable !== false && !TERMINAL_REASONS.has(verified.reason),
    };
  }

  // 2. The product id the PLATFORM reported, not the one the client sent.
  const resolvedProductId = verified.productId;
  const pack = await resolvePack(resolvedProductId);
  if (!pack) {
    // Money has changed hands and we cannot map it to a product. That is an
    // operator configuration gap, not buyer fraud, so it is logged at error
    // and reported as non-retryable so the client stops looping - but the
    // purchase is deliberately NOT claimed, so it can be redeemed once the
    // SKU mapping is fixed.
    logger.error("purchase_unknown_product", { userId, platform, productId: resolvedProductId });
    return { granted: false, reason: "unknown_product", retryable: false };
  }

  // 3. Claim before granting.
  const claim = await db.query(
    `INSERT INTO processed_purchases
       (purchase_id, platform, user_id, product_id, credits_granted, order_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (purchase_id) DO NOTHING`,
    [purchaseToken, platform, userId, resolvedProductId, pack.credits, verified.orderId || null]
  );

  if (claim.rowCount === 0) {
    // Someone already redeemed this - the same user retrying, a restore, or a
    // concurrent request that won the race. All three are successes from the
    // caller's point of view, and none may grant a second time.
    // getBalance returns the balance as a plain number, not a wrapper.
    const balance = await walletService.getBalance(userId);
    logger.info("purchase_already_redeemed", { userId, platform, productId: resolvedProductId });
    return { granted: false, alreadyRedeemed: true, credits: 0, balance };
  }

  // 4. Grant. On failure, release the claim so the buyer can retry rather than
  //    being left with a consumed token and no credits.
  let result;
  try {
    result = await walletService.addBalance(
      userId,
      pack.credits,
      "purchase",
      `Credit pack purchased (${pack.name})`
    );
  } catch (err) {
    try {
      await db.query("DELETE FROM processed_purchases WHERE purchase_id = $1", [purchaseToken]);
    } catch (releaseErr) {
      // Now the token is claimed but uncredited. Loud, because only a human
      // can reconcile it - and the buyer paid.
      logger.error("purchase_claim_release_failed", {
        userId,
        platform,
        purchaseIdPresent: true,
        error: (releaseErr && releaseErr.message) || "unknown",
      });
    }
    logger.error("purchase_grant_failed", {
      userId,
      platform,
      error: (err && err.message) || "unknown",
    });
    return { granted: false, reason: "grant_failed", retryable: true };
  }

  // 5. Acknowledge last. A failure here does not fail the request - the buyer
  //    has their credits - but it is recorded so the three-day auto-refund
  //    window is queryable rather than silent.
  const ack = await verifier.acknowledgePurchase({ productId: resolvedProductId, purchaseToken });
  if (ack.ok) {
    try {
      await db.query(
        "UPDATE processed_purchases SET acknowledged = TRUE WHERE purchase_id = $1",
        [purchaseToken]
      );
    } catch (err) {
      logger.error("purchase_acknowledge_flag_failed", {
        error: (err && err.message) || "unknown",
      });
    }
  } else {
    logger.error("purchase_unacknowledged", {
      userId,
      platform,
      productId: resolvedProductId,
      reason: ack.reason,
    });
  }

  logger.info("purchase_redeemed", {
    userId,
    platform,
    productId: resolvedProductId,
    credits: pack.credits,
  });

  // addBalance returns the updated balance as a plain number.
  return { granted: true, credits: pack.credits, balance: result, productId: resolvedProductId };
}

/**
 * Restore: redeem a batch of purchases the device still holds.
 *
 * Reuses redeemPurchase per item precisely because it is idempotent - restore
 * is, by definition, re-presenting purchases that were probably already
 * redeemed, and a separate "restore" code path would be a second place for the
 * double-grant bug to live.
 *
 * Never throws for one bad item: a single unverifiable purchase in a batch of
 * five must not deny the user the other four.
 */
async function restorePurchases({ userId, platform, purchases }) {
  const results = [];
  let creditsGranted = 0;

  for (const purchase of purchases) {
    // eslint-disable-next-line no-await-in-loop
    const outcome = await redeemPurchase({
      userId,
      platform,
      productId: purchase.productId,
      purchaseToken: purchase.purchaseToken,
    });

    if (outcome.granted) creditsGranted += outcome.credits || 0;

    results.push({
      productId: purchase.productId,
      granted: Boolean(outcome.granted),
      alreadyRedeemed: Boolean(outcome.alreadyRedeemed),
      reason: outcome.reason || null,
    });
  }

  const balance = await walletService.getBalance(userId);

  return { creditsGranted, balance, results };
}

/** Which platforms can actually verify right now. Drives the readiness surface. */
function configuredPlatforms(env = process.env) {
  return {
    google: googlePlayVerifier.isConfigured(env),
    apple: appleVerifier.isConfigured(env),
  };
}

module.exports = {
  redeemPurchase,
  restorePurchases,
  resolvePack,
  configuredPlatforms,
  verifierFor,
  TERMINAL_REASONS,
};
