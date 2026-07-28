const bcrypt = require("bcrypt");
const db = require("../config/db");
const jwt = require("jsonwebtoken");
const { z } = require("zod");
const walletService = require("../services/wallet/walletService");

const adminLoginSchema = z.object({
  email: z.string().email("Invalid email format"),
  password: z.string().min(1, "Password is required"),
});

// SEC-1.2/SEC-15.7: dummy hash compared against when the admin email is
// unknown, so login timing can't be used to probe which emails are admin
// accounts. Generated from 32 random bytes - no real password matches it -
// and the cost (12) must stay equal to createAdmin.js's bcrypt.hash(..., 12)
// (asserted in adminController.login.test.js).
const DUMMY_ADMIN_PASSWORD_HASH = '$2b$12$X6koHogGAqEGpjfG.7XTxuBgjldtL/KM/gktOopwun.V5BACytfCe';

// SEC-1.3 (the lockout half of SEC-15.7): per-account lockout for admin
// login, same mechanism and constants as the user path in authController -
// see the comments there for the atomicity and disclosure reasoning.
const MAX_FAILED_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

const RECORD_FAILED_ADMIN_LOGIN_SQL = `
  UPDATE admins
  SET failed_login_attempts = CASE
        WHEN locked_until IS NOT NULL AND locked_until <= now() THEN 1
        ELSE failed_login_attempts + 1
      END,
      locked_until = CASE
        WHEN locked_until IS NOT NULL AND locked_until <= now() THEN NULL
        WHEN failed_login_attempts + 1 >= ${MAX_FAILED_LOGIN_ATTEMPTS}
          THEN now() + interval '${LOCKOUT_MINUTES} minutes'
        ELSE locked_until
      END
  WHERE id = $1
  RETURNING failed_login_attempts, locked_until`;

async function login(req, res) {
  try {
    const parsed = adminLoginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.issues[0].message });
    }
    const { email, password } = parsed.data;

    const result = await db.query(
      `SELECT id, email, full_name, password_hash,
              (locked_until IS NOT NULL AND locked_until > now()) AS is_locked
       FROM admins
       WHERE email = $1`,
      [email.toLowerCase()]
    );

    if (result.rows.length === 0) {
      // SEC-1.2/SEC-15.7: burn the same bcrypt work as a real comparison
      // before the generic 401, so a timing probe can't distinguish this path.
      await bcrypt.compare(password, DUMMY_ADMIN_PASSWORD_HASH);
      return res.status(401).json({
        message: "Invalid email or password."
      });
    }

    const admin = result.rows[0];

    // SEC-1.3: locked admin account - same generic 401 and dummy bcrypt work
    // as the unknown-email path; the real hash is never evaluated while
    // locked, and neither response nor timing reveals the lock.
    if (admin.is_locked) {
      await bcrypt.compare(password, DUMMY_ADMIN_PASSWORD_HASH);
      return res.status(401).json({
        message: "Invalid email or password."
      });
    }

    const valid = await bcrypt.compare(
      password,
      admin.password_hash
    );

    if (!valid) {
      // SEC-1.3: count the failure and lock the account at the threshold.
      const failRes = await db.query(RECORD_FAILED_ADMIN_LOGIN_SQL, [admin.id]);
      const updated = failRes.rows[0];
      if (updated && updated.failed_login_attempts === MAX_FAILED_LOGIN_ATTEMPTS && updated.locked_until) {
        console.warn(`[security] admin account locked for ${LOCKOUT_MINUTES}m after ${MAX_FAILED_LOGIN_ATTEMPTS} failed logins: admin ${admin.id}`);
      }
      return res.status(401).json({
        message: "Invalid email or password."
      });
    }

    // Successful login restores the full failed-attempt budget (SEC-1.3).
    await db.query(
      'UPDATE admins SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1',
      [admin.id]
    );

    const accessToken = jwt.sign(
      {
        sub: admin.id,
        email: admin.email,
        role: "admin"
      },
      process.env.ADMIN_JWT_SECRET,
      {
        // SEC-1.7: state the algorithm rather than relying on jwt.sign's
        // default, so the signer and adminAuthMiddleware's pinned verifier
        // can't drift apart if that default ever changes.
        algorithm: "HS256",
        // Short-lived by default: the token lives in the dashboard's
        // localStorage with no server-side revocation, so its lifetime is
        // the whole exposure window if it's ever exfiltrated.
        expiresIn: process.env.ADMIN_JWT_EXPIRES_IN || "2h"
      }
    );

    res.json({
      accessToken,
      user: {
        id: admin.id,
        email: admin.email,
        fullName: admin.full_name,
        role: "admin"
      }
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      message: "Internal server error."
    });
  }
}

/**
 * GET /api/admin/users/search?email=...
 * Looks up a single user by email so the admin can find who to adjust.
 */
async function searchUserByEmail(req, res) {
  try {
    const email = req.query.email;
    if (!email) {
      return res.status(400).json({ message: "Email is required." });
    }

    const result = await db.query(
      `SELECT id, email, full_name AS "fullName", balance
       FROM users
       WHERE email = $1`,
      [email.toLowerCase()]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "No user found with this email." });
    }

    res.json(result.rows[0]);

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Internal server error." });
  }
}

/**
 * POST /api/admin/users/:id/adjust-balance
 * Manually adds or deducts credits for a user, recorded as a type="admin"
 * ledger entry. Positive amount adds, negative amount deducts (and fails if
 * the user doesn't have enough balance to cover it).
 */
async function adjustUserBalance(req, res) {
  try {
    const { id } = req.params;
    const { amount, description } = req.body;

    const numericAmount = Number(amount);
    if (!Number.isInteger(numericAmount) || numericAmount === 0) {
      return res.status(400).json({ message: "Amount must be a non-zero whole number." });
    }

    if (!description?.trim()) {
      return res.status(400).json({ message: "A reason/description is required." });
    }

    // SEC-15.1: this is the money path, so the audit row is written inside the
    // same transaction as the balance change rather than after the fact by the
    // global middleware - if it can't be recorded, the credits don't move.
    // `req.auditWritten` stops the middleware recording the action a second
    // time. req.admin is set by adminAuthMiddleware from the verified JWT.
    const actor = {
      adminId: req.admin.id,
      adminEmail: req.admin.email,
      ip: req.ip || null,
      requestUrl: req.originalUrl,
    };

    let newBalance;
    if (numericAmount > 0) {
      newBalance = await walletService.addBalance(id, numericAmount, "admin", description.trim(), actor);
    } else {
      newBalance = await walletService.deductBalance(id, Math.abs(numericAmount), "admin", description.trim(), actor);
    }
    req.auditWritten = true;

    res.json({ balance: newBalance });

  } catch (err) {
    if (err.message === "User not found") {
      return res.status(404).json({ message: "User not found." });
    }
    if (err.message === "Insufficient balance") {
      return res.status(400).json({ message: "User does not have enough balance for this deduction." });
    }

    console.error(err);
    res.status(500).json({ message: "Internal server error." });
  }
}

module.exports = {
  login,
  searchUserByEmail,
  adjustUserBalance,
};