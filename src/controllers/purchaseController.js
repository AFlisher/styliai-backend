"use strict";

const purchaseService = require("../services/purchases/purchaseService");
const { AppError, ErrorCodes } = require("../utils/errors");
const { logAuditEvent, logUnexpectedError } = require("../utils/securityEvents");

/**
 * Sprint 2 / B-3 — server-verified in-app purchases.
 *
 * Replaces a paywall that granted credits in device memory and never contacted
 * this server. The endpoints below are the ONLY way credits can be created from
 * a purchase, and neither trusts the client for anything except the opaque
 * token it is presenting.
 */

const SUPPORTED_PLATFORMS = new Set(["google", "apple"]);

/** Bounds on the opaque token. Long, because Google's are, but not unbounded. */
const MAX_TOKEN_LENGTH = 4096;
const MAX_PRODUCT_ID_LENGTH = 255;

/** A restore replays what the device holds; a device holding 50 is already odd. */
const MAX_RESTORE_BATCH = 50;

function validatePurchaseInput({ platform, productId, purchaseToken }) {
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, "platform must be 'google' or 'apple'.", 400);
  }
  if (typeof productId !== "string" || !productId.trim() || productId.length > MAX_PRODUCT_ID_LENGTH) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, "productId is required.", 400);
  }
  if (
    typeof purchaseToken !== "string" ||
    !purchaseToken.trim() ||
    purchaseToken.length > MAX_TOKEN_LENGTH
  ) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, "purchaseToken is required.", 400);
  }
}

/**
 * Maps a service-layer refusal to an HTTP answer.
 *
 * The distinction that matters is retryable vs terminal, because it decides
 * whether the client keeps a purchase pending on the device or gives up on it.
 * Getting this backwards either loses a paid purchase or spins forever.
 */
function refusalToError(outcome) {
  switch (outcome.reason) {
    case "not_configured":
    case "verification_unavailable":
    case "verifier_unauthorized":
    case "grant_failed":
      // Ours, not theirs. 503 so the client retries and keeps the purchase.
      return new AppError(
        ErrorCodes.PROVIDER_UNAVAILABLE,
        "Purchases cannot be verified right now. Your purchase is safe - please try again shortly.",
        503
      );

    case "purchase_pending":
      return new AppError(
        ErrorCodes.PROVIDER_UNAVAILABLE,
        "This purchase has not completed yet. It will be credited once your payment clears.",
        503
      );

    case "unknown_product":
      // Money took, product unmapped. The buyer can do nothing about it, so
      // the message must not blame them or suggest retrying.
      return new AppError(
        ErrorCodes.VALIDATION_ERROR,
        "This product is not available. Please contact support - you have not lost your purchase.",
        422
      );

    case "purchase_not_found":
    case "purchase_cancelled":
    case "purchase_not_completed":
    case "already_consumed":
      return new AppError(
        ErrorCodes.VALIDATION_ERROR,
        "This purchase could not be verified.",
        422
      );

    default:
      return new AppError(ErrorCodes.VALIDATION_ERROR, "This purchase could not be verified.", 422);
  }
}

/**
 * POST /api/purchases/verify
 * Body: { platform, productId, purchaseToken }
 *
 * Idempotent: presenting the same purchaseToken twice credits once and answers
 * 200 both times. That is what lets the client retry safely after a lost
 * response, which is the case that produced double charges before Sprint 2.
 */
async function verifyPurchase(req, res, next) {
  const userId = req.user && req.user.id;

  try {
    const { platform, productId, purchaseToken } = req.body || {};
    validatePurchaseInput({ platform, productId, purchaseToken });

    const outcome = await purchaseService.redeemPurchase({
      userId,
      platform,
      productId,
      purchaseToken,
    });

    if (outcome.granted) {
      logAuditEvent(req, {
        action: "purchase_redeemed",
        outcome: "success",
        subject: userId,
        details: { platform, productId: outcome.productId, credits: outcome.credits },
      });
      return res.status(200).json({
        success: true,
        granted: true,
        credits: outcome.credits,
        balance: outcome.balance,
      });
    }

    if (outcome.alreadyRedeemed) {
      // Not an error. The client asked "please credit this", and it is credited.
      return res.status(200).json({
        success: true,
        granted: false,
        alreadyRedeemed: true,
        credits: 0,
        balance: outcome.balance,
      });
    }

    logAuditEvent(req, {
      action: "purchase_redeemed",
      outcome: "failure",
      subject: userId,
      details: { platform, reason: outcome.reason },
    });
    return next(refusalToError(outcome));
  } catch (err) {
    if (err instanceof AppError) return next(err);
    logUnexpectedError(req, err, { where: "verifyPurchase" });
    return next(
      new AppError(
        ErrorCodes.INTERNAL_ERROR,
        "Purchase verification failed. Your purchase is safe - please try again.",
        500
      )
    );
  }
}

/**
 * POST /api/purchases/restore
 * Body: { platform, purchases: [{ productId, purchaseToken }] }
 *
 * Required by both stores for non-consumable-style entitlements and expected by
 * users who reinstall. Every item goes through the same idempotent redemption,
 * so a restore of already-credited purchases grants nothing and still succeeds.
 */
async function restorePurchases(req, res, next) {
  const userId = req.user && req.user.id;

  try {
    const { platform, purchases } = req.body || {};

    if (!SUPPORTED_PLATFORMS.has(platform)) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, "platform must be 'google' or 'apple'.", 400);
    }
    if (!Array.isArray(purchases)) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, "purchases must be an array.", 400);
    }
    if (purchases.length === 0) {
      return res.status(200).json({ success: true, creditsGranted: 0, results: [] });
    }
    if (purchases.length > MAX_RESTORE_BATCH) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        `A restore may contain at most ${MAX_RESTORE_BATCH} purchases.`,
        400
      );
    }

    // Validate every item before redeeming any, so a malformed tail does not
    // leave a half-processed batch.
    purchases.forEach((p) =>
      validatePurchaseInput({
        platform,
        productId: p && p.productId,
        purchaseToken: p && p.purchaseToken,
      })
    );

    const outcome = await purchaseService.restorePurchases({ userId, platform, purchases });

    logAuditEvent(req, {
      action: "purchase_restore",
      outcome: "success",
      subject: userId,
      details: { platform, count: purchases.length, creditsGranted: outcome.creditsGranted },
    });

    return res.status(200).json({
      success: true,
      creditsGranted: outcome.creditsGranted,
      balance: outcome.balance,
      results: outcome.results,
    });
  } catch (err) {
    if (err instanceof AppError) return next(err);
    logUnexpectedError(req, err, { where: "restorePurchases" });
    return next(
      new AppError(ErrorCodes.INTERNAL_ERROR, "Restore failed. Please try again.", 500)
    );
  }
}

/**
 * GET /api/purchases/config
 *
 * Tells the client which platforms can actually be verified. The app uses this
 * to hide the purchase UI rather than let a user pay into a backend that cannot
 * credit them - which is the exact failure Sprint 2 exists to remove, and it
 * would be perverse to reintroduce it in a different shape.
 */
function purchaseConfig(req, res) {
  const platforms = purchaseService.configuredPlatforms();
  res.set("Cache-Control", "no-store");
  return res.status(200).json({ platforms });
}

module.exports = {
  verifyPurchase,
  restorePurchases,
  purchaseConfig,
  validatePurchaseInput,
  refusalToError,
  MAX_TOKEN_LENGTH,
  MAX_RESTORE_BATCH,
};
