/**
 * WalletController - Handles HTTP requests for user wallets and transaction history.
 */

const db = require("../config/db");
const walletService = require("../services/wallet/walletService");

/**
 * GET /api/wallet
 * Returns user balance, ads progress, and generated images count.
 */
async function getWalletInfo(req, res, next) {
  try {
    const userId = req.user.id;

    // Fetch balance from walletService
    const balance = await walletService.getBalance(userId);

    // Fetch ads_progress and generated_images from the users table
    const userRes = await db.query(
      'SELECT ads_progress AS "adsProgress", generated_images AS "generatedImages" FROM users WHERE id = $1',
      [userId]
    );

    if (userRes.rows.length === 0) {
      return res.status(404).json({ message: "User not found." });
    }

    const { adsProgress, generatedImages } = userRes.rows[0];

    return res.json({
      balance,
      adsProgress: adsProgress ?? 0,
      generatedImages: generatedImages ?? 0,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/wallet/history
 * Returns the transaction history of the authenticated user, newest first.
 */
async function getWalletHistory(req, res, next) {
  try {
    const userId = req.user.id;
    
    // Fetch transaction history
    const history = await walletService.getTransactionHistory(userId);
    
    return res.json(history);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getWalletInfo,
  getWalletHistory,
};
