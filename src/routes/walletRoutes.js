/**
 * WalletRoutes - Defines routes for accessing wallet information and transaction history.
 */

const express = require("express");
const router = express.Router();
const walletController = require("../controllers/walletController");
const authMiddleware = require("../middleware/authMiddleware");

// All wallet endpoints require JWT authentication
router.use(authMiddleware);

// GET /api/wallet
router.get("/", walletController.getWalletInfo);

// GET /api/wallet/history
router.get("/history", walletController.getWalletHistory);

module.exports = router;
