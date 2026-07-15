const bcrypt = require("bcrypt");
const db = require("../config/db");
const jwt = require("jsonwebtoken");
const { z } = require("zod");
const walletService = require("../services/wallet/walletService");

const adminLoginSchema = z.object({
  email: z.string().email("Invalid email format"),
  password: z.string().min(1, "Password is required"),
});

async function login(req, res) {
  try {
    const parsed = adminLoginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.issues[0].message });
    }
    const { email, password } = parsed.data;

    const result = await db.query(
      `SELECT id, email, full_name, password_hash
       FROM admins
       WHERE email = $1`,
      [email.toLowerCase()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        message: "Invalid email or password."
      });
    }

    const admin = result.rows[0];

    const valid = await bcrypt.compare(
      password,
      admin.password_hash
    );

    if (!valid) {
      return res.status(401).json({
        message: "Invalid email or password."
      });
    }

    const accessToken = jwt.sign(
      {
        sub: admin.id,
        email: admin.email,
        role: "admin"
      },
      process.env.ADMIN_JWT_SECRET,
      {
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

    let newBalance;
    if (numericAmount > 0) {
      newBalance = await walletService.addBalance(id, numericAmount, "admin", description.trim());
    } else {
      newBalance = await walletService.deductBalance(id, Math.abs(numericAmount), "admin", description.trim());
    }

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