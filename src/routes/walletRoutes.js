/**
 * WalletRoutes - Defines routes for accessing wallet information and transaction history.
 */

const express = require("express");
const router = express.Router();
const walletController = require("../controllers/walletController");
const authMiddleware = require("../middleware/authMiddleware");

// POST /api/wallet/reward/verify (No auth required, called directly by Google AdMob callback)
router.post("/reward/verify", walletController.verifyRewardedAd);

// All wallet endpoints below require JWT authentication
router.use(authMiddleware);

// GET /api/wallet
router.get("/", walletController.getWalletInfo);

// GET /api/wallet/history
router.get("/history", walletController.getWalletHistory);

// POST /api/wallet/reward
router.post("/reward", walletController.rewardAd);

module.exports = router;