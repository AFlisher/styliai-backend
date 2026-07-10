const crypto = require("crypto");
const db = require("../config/db");
const walletService = require("../services/wallet/walletService");

/**
 * Helper to verify AdMob SSV signature cryptographically using Google's public keys.
 */
async function verifyAdMobSSVSignature(req, signature, keyId) {
  try {
    const res = await fetch("https://www.gstatic.com/admob/reward/keys-v1.json");
    const { keys } = await res.json();
    const keyObj = keys.find(k => k.keyId === keyId);
    if (!keyObj) return false;

    const publicKeyPem = keyObj.pem;

    // Google AdMob SSV Message Construction:
    // Extract raw query string up to the &signature= parameter
    const urlParts = (req.originalUrl || req.url).split("/reward/verify?");
    if (urlParts.length < 2) return false;
    
    const rawQueryString = urlParts[1];
    const messagePart = rawQueryString.split("&signature=")[0];

    // Decode base64url signature
    const sigBuffer = Buffer.from(signature.replace(/-/g, "+").replace(/_/g, "/"), "base64");

    const verifier = crypto.createVerify("SHA256");
    verifier.update(messagePart);
    
    return verifier.verify(publicKeyPem, sigBuffer);
  } catch (err) {
    console.error("Signature verification failed:", err);
    return false;
  }
}

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

    // Check if the user has reached their daily limit of free reward credits today
    const limitRes = await db.query(
      "SELECT id FROM daily_rewards WHERE user_id = $1 AND reward_date = CURRENT_DATE AND credits_claimed >= 1",
      [userId]
    );
    const dailyLimitReached = limitRes.rows.length > 0;

    return res.json({
      balance,
      adsProgress: adsProgress ?? 0,
      generatedImages: generatedImages ?? 0,
      dailyLimitReached,
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

/**
 * POST /api/wallet/reward
 * Called after the user successfully watches a rewarded ad.
 */
async function rewardAd(req, res, next) {
  try {
    const userId = req.user.id;

    const result = await walletService.rewardAd(userId);

    return res.json(result);
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/wallet/reward/verify
 * Handles Server-Side Verification (SSV) callback from Google AdMob.
 */
async function verifyRewardedAd(req, res) {
  try {
    const {
      user_id,
      custom_data,
      reward_amount,
      reward_item,
      transaction_id,
      key_id,
      signature
    } = { ...req.query, ...req.body };

    const transactionId = transaction_id;
    const userId = custom_data || user_id;

    if (!transactionId) {
      return res.status(400).json({ message: "transaction_id is required." });
    }

    if (!userId) {
      return res.status(400).json({ message: "user_id or custom_data is required." });
    }

    // Auto-create processed transactions table if not exists
    await db.query(`
      CREATE TABLE IF NOT EXISTS processed_ad_transactions (
        transaction_id TEXT PRIMARY KEY,
        user_id UUID NOT NULL,
        reward_amount INTEGER,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `);

    // Check duplicate transaction_id to prevent duplicate claims
    const dupCheck = await db.query(
      "SELECT transaction_id FROM processed_ad_transactions WHERE transaction_id = $1",
      [transactionId]
    );

    if (dupCheck.rows.length > 0) {
      return res.status(200).json({ message: "Duplicate transaction ignored" });
    }

    // Crytographic signature check (when signature parameters are provided)
    if (signature && key_id) {
      const isValid = await verifyAdMobSSVSignature(req, signature, key_id);
      if (!isValid) {
        return res.status(400).json({ message: "Invalid AdMob SSV signature" });
      }
    }

    // Call existing wallet reward logic
    const rewardResult = await walletService.rewardAd(userId);

    // Save transaction_id to avoid replay/duplicate grants
    await db.query(
      "INSERT INTO processed_ad_transactions (transaction_id, user_id, reward_amount) VALUES ($1, $2, $3)",
      [transactionId, userId, reward_amount ? Number(reward_amount) : 1]
    );

    return res.status(200).json({
      success: true,
      message: "Reward verified and processed successfully",
      rewardResult
    });

  } catch (err) {
    console.error("AdMob SSV Error:", err);
    return res.status(500).json({ message: err.message || "Failed to verify AdMob rewarded ad." });
  }
}

module.exports = {
  getWalletInfo,
  getWalletHistory,
  rewardAd,
  verifyRewardedAd,
};
