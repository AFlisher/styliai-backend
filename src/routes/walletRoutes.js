/**
 * WalletRoutes - Defines routes for accessing wallet information and transaction history.
 */

const express = require("express");
const router = express.Router();
const walletController = require("../controllers/walletController");
const authMiddleware = require("../middleware/authMiddleware");
const { ssvCallbackLimiter, rewardClaimLimiter, userDataLimiter } = require("../middleware/rateLimiters");

// POST /api/wallet/reward/verify (No auth required, called directly by Google AdMob callback)
router.post("/reward/verify", ssvCallbackLimiter, walletController.verifyRewardedAd);

// All wallet endpoints below require JWT authentication
router.use(authMiddleware);

// GET /api/wallet
router.get("/", userDataLimiter, walletController.getWalletInfo);

// GET /api/wallet/history
router.get("/history", userDataLimiter, walletController.getWalletHistory);

// POST /api/wallet/reward
router.post("/reward", rewardClaimLimiter, walletController.rewardAd);

module.exports = router;
