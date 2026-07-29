/**
 * WalletRoutes - Defines routes for accessing wallet information and transaction history.
 */

const express = require("express");
const verifyIntegrity = require("../middleware/verifyIntegrity");
const interpretIntegrity = require("../middleware/interpretIntegrity");
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
// SEC-0.2: verifyIntegrity annotates req.integrity and never denies.
router.post("/reward", rewardClaimLimiter, verifyIntegrity, interpretIntegrity, walletController.rewardAd);

module.exports = router;
