const express = require("express");

const authMiddleware = require("../middleware/authMiddleware");
const purchaseController = require("../controllers/purchaseController");
const { idempotency } = require("../middleware/idempotency");
const { accountActionLimiter, userDataLimiter } = require("../middleware/rateLimiters");

const router = express.Router();

/**
 * Sprint 2 / B-3 — server-verified purchases.
 *
 * Auth precedes everything: a purchase is credited to the bearer of the token
 * and to nobody else, and there is no user id anywhere in these request bodies.
 *
 * `idempotency` is mounted on the two mutating routes even though redemption is
 * ALREADY idempotent on the store's purchase token (processed_purchases'
 * primary key). The two guards cover different failures and neither subsumes
 * the other: the purchase-token claim stops one purchase being credited twice,
 * while the Idempotency-Key stops a retried HTTP request doing redundant
 * verification work against Google's quota-limited API and re-running the whole
 * pipeline. Belt and braces here is cheap; a double credit is not.
 */
router.post(
  "/verify",
  accountActionLimiter,
  authMiddleware,
  idempotency({ endpoint: "POST /api/purchases/verify" }),
  purchaseController.verifyPurchase
);

router.post(
  "/restore",
  accountActionLimiter,
  authMiddleware,
  idempotency({ endpoint: "POST /api/purchases/restore" }),
  purchaseController.restorePurchases
);

// Read-only, and deliberately behind auth: which store integrations are live is
// operational detail, not something to hand an anonymous caller.
router.get("/config", userDataLimiter, authMiddleware, purchaseController.purchaseConfig);

module.exports = router;
