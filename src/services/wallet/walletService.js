/**
 * WalletService - Manages user balances and wallet transactions with PostgreSQL transactions.
 */

const { v4: uuidv4 } = require("uuid");
const db = require("../../config/db");

// Allowed transaction types as per requirements
const ALLOWED_TYPES = ["purchase", "reward", "generation", "refund", "admin"];

/**
 * Validates the transaction type.
 * @param {string} type 
 */
function validateType(type) {
  if (!ALLOWED_TYPES.includes(type)) {
    throw new Error(
      `Invalid transaction type: "${type}". Allowed types: ${ALLOWED_TYPES.join(", ")}`
    );
  }
}

/**
 * Validates the amount value.
 * @param {number} amount 
 */
function validateAmount(amount) {
  if (typeof amount !== "number" || amount <= 0 || !Number.isInteger(amount)) {
    throw new Error("Amount must be a positive integer.");
  }
}

/**
 * Retrieves the current balance for a user.
 * 
 * @param {string} userId - UUID of the user.
 * @returns {Promise<number>} Current balance.
 */
async function getBalance(userId) {
  if (!userId) throw new Error("userId is required.");
  
  const res = await db.query("SELECT balance FROM users WHERE id = $1", [userId]);
  if (res.rows.length === 0) {
    throw new Error("User not found");
  }
  
  return res.rows[0].balance ?? 0;
}

/**
 * Records a transaction record inside the database using an existing client connection.
 * Used internally within active SQL transactions.
 * 
 * @param {Object} client - Active pg client connection.
 * @param {string} userId - UUID of the user.
 * @param {number} amount - Transaction amount (positive for credit, negative for debit).
 * @param {string} type - Transaction type.
 * @param {string} description - Transaction description.
 * @returns {Promise<Object>} The recorded transaction row.
 */
async function recordTransaction(client, userId, amount, type, description) {
  validateType(type);
  
  const transactionId = uuidv4();
  const queryText = `
    INSERT INTO wallet_transactions (id, user_id, amount, type, description, created_at)
    VALUES ($1, $2, $3, $4, $5, NOW())
    RETURNING id, user_id AS "userId", amount, type, description, created_at AS "createdAt"
  `;
  const values = [transactionId, userId, amount, type, description];
  const res = await client.query(queryText, values);
  return res.rows[0];
}

/**
 * Adds credits to a user's wallet balance.
 * Runs inside a secure database transaction with row-level locks.
 * 
 * @param {string} userId - UUID of the user.
 * @param {number} amount - Positive integer to credit.
 * @param {string} type - Transaction type.
 * @param {string} description - Transaction description.
 * @returns {Promise<number>} The updated wallet balance.
 */
async function addBalance(userId, amount, type, description) {
  validateAmount(amount);
  validateType(type);

  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Lock the user row (FOR UPDATE)
    const userRes = await client.query(
      "SELECT balance FROM users WHERE id = $1 FOR UPDATE",
      [userId]
    );
    if (userRes.rows.length === 0) {
      throw new Error("User not found");
    }

    const currentBalance = userRes.rows[0].balance ?? 0;
    const newBalance = currentBalance + amount;

    // 2. Update user balance

  if (type === "generation") {
    await client.query(
      `
      UPDATE users
      SET
          balance = $1,
          generated_images = generated_images + 1
      WHERE id = $2
      `,
      [newBalance, userId]
    );
  } else {
    await client.query(
      `
      UPDATE users
      SET balance = $1
      WHERE id = $2
      `,
      [newBalance, userId]
    );
  }

    // 3. Record transaction
    await recordTransaction(client, userId, amount, type, description);

    await client.query("COMMIT");
    return newBalance;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Deducts credits from a user's wallet balance.
 * Runs inside a secure database transaction, ensuring the user has sufficient credits.
 * 
 * @param {string} userId - UUID of the user.
 * @param {number} amount - Positive integer to deduct.
 * @param {string} type - Transaction type.
 * @param {string} description - Transaction description.
 * @returns {Promise<number>} The updated wallet balance.
 */
async function deductBalance(userId, amount, type, description) {
  validateAmount(amount);
  validateType(type);

  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Lock the user row (FOR UPDATE)
    const userRes = await client.query(
      "SELECT balance FROM users WHERE id = $1 FOR UPDATE",
      [userId]
    );
    if (userRes.rows.length === 0) {
      throw new Error("User not found");
    }

    const currentBalance = userRes.rows[0].balance ?? 0;

    // 2. Check if balance is sufficient
    if (currentBalance < amount) {
      throw new Error("Insufficient balance");
    }

    const newBalance = currentBalance - amount;

    // 3. Update user balance
    await client.query(
      "UPDATE users SET balance = $1 WHERE id = $2",
      [newBalance, userId]
    );

    // 4. Record transaction (as a negative amount for deductions)
    await recordTransaction(client, userId, -amount, type, description);

    await client.query("COMMIT");
    return newBalance;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Retrieves the transaction history for a user.
 * 
 * @param {string} userId - UUID of the user.
 * @returns {Promise<Array>} List of transaction records sorted by date descending.
 */
async function getTransactionHistory(userId) {
  if (!userId) throw new Error("userId is required.");

  const queryText = `
    SELECT id, user_id AS "userId", amount, type, description, created_at AS "createdAt"
    FROM wallet_transactions
    WHERE user_id = $1
    ORDER BY created_at DESC
  `;
  const res = await db.query(queryText, [userId]);
  return res.rows;
}

/**
 * Rewards the user after watching rewarded ads.
 * Every 2 ads = +1 balance.
 */
async function rewardAd(userId) {
  const client = await db.pool.connect();

  try {
    await client.query("BEGIN");

    // Auto-create daily_rewards table if not exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS daily_rewards (
        id SERIAL PRIMARY KEY,
        user_id UUID NOT NULL,
        reward_date DATE NOT NULL DEFAULT CURRENT_DATE,
        credits_claimed INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        UNIQUE(user_id, reward_date)
      )
    `);

    // Check if user has already claimed today's credit
    const limitCheck = await client.query(
      `
      SELECT credits_claimed
      FROM daily_rewards
      WHERE user_id = $1 AND reward_date = CURRENT_DATE
      `,
      [userId]
    );

    if (limitCheck.rows.length > 0 && limitCheck.rows[0].credits_claimed >= 1) {
      await client.query("COMMIT");
      return {
        rewarded: false,
        dailyLimitReached: true,
        message: "Daily free credit already claimed."
      };
    }

    const userRes = await client.query(
      `
      SELECT balance, ads_progress
      FROM users
      WHERE id = $1
      FOR UPDATE
      `,
      [userId]
    );

    if (userRes.rows.length === 0) {
      throw new Error("User not found");
    }

    let balance = Number(userRes.rows[0].balance || 0);
    let adsProgress = Number(userRes.rows[0].ads_progress || 0);

    adsProgress++;

    // Less than 2 ads
    if (adsProgress < 2) {
      await client.query(
        `
        UPDATE users
        SET ads_progress = $1
        WHERE id = $2
        `,
        [adsProgress, userId]
      );

      await client.query("COMMIT");

      return {
        rewarded: false,
        balance,
        adsProgress,
      };
    }

    // 2 ads => Grant 1 Credit
    balance++;

    await client.query(
      `
      UPDATE users
      SET
          balance = $1,
          ads_progress = 0
      WHERE id = $2
      `,
      [balance, userId]
    );

    await recordTransaction(
      client,
      userId,
      1,
      "reward",
      "Rewarded for watching 2 ads"
    );

    // Insert today's row into daily_rewards to lock out further rewards
    await client.query(
      `
      INSERT INTO daily_rewards (user_id, reward_date, credits_claimed, created_at, updated_at)
      VALUES ($1, CURRENT_DATE, 1, NOW(), NOW())
      ON CONFLICT (user_id, reward_date)
      DO UPDATE SET credits_claimed = daily_rewards.credits_claimed + 1, updated_at = NOW()
      `,
      [userId]
    );

    await client.query("COMMIT");

    return {
      rewarded: true,
      balance,
      adsProgress: 0,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  getBalance,
  addBalance,
  deductBalance,
  rewardAd,
  recordTransaction,
  getTransactionHistory,
};
