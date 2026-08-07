const bcrypt = require("bcrypt");
const db = require("../config/db");
const sessionService = require("../services/sessionService");
const jwt = require("jsonwebtoken");
const { z } = require("zod");
const walletService = require("../services/wallet/walletService");
const adminMfaService = require("../services/adminMfaService");
const { clampLimit } = require("../utils/pagination");

const adminLoginSchema = z.object({
  email: z.string().email("Invalid email format"),
  password: z.string().min(1, "Password is required"),
  // SEC-15.2: the second factor travels with the credentials rather than being
  // exchanged for an intermediate "MFA pending" token. A partially-authenticated
  // bearer credential is precisely the shape of SEC-1.1 (refresh tokens accepted
  // as access tokens) - not inventing one is the point.
  //
  // Optional at the schema level because unenrolled admins never send it; the
  // enforcement decision is made below, per account, from mfa_enabled.
  // Bounded so an oversized value is rejected by validation rather than
  // reaching the normalizer and the format checks below it.
  totpCode: z.string().max(16).optional(),
  recoveryCode: z.string().max(64).optional(),
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

/**
 * Counts one failed authentication attempt against the account and locks it at
 * the threshold (SEC-1.3).
 *
 * Extracted so the SEC-15.2 second-factor path counts toward the exact same
 * budget as a wrong password - two separate counters would let an attacker who
 * knows the password get a fresh allowance of code guesses.
 */
async function recordFailedAttempt(adminId) {
  const failRes = await db.query(RECORD_FAILED_ADMIN_LOGIN_SQL, [adminId]);
  const updated = failRes.rows[0];
  if (updated && updated.failed_login_attempts === MAX_FAILED_LOGIN_ATTEMPTS && updated.locked_until) {
    console.warn(`[security] admin account locked for ${LOCKOUT_MINUTES}m after ${MAX_FAILED_LOGIN_ATTEMPTS} failed logins: admin ${adminId}`);
  }
}

async function login(req, res) {
  try {
    const parsed = adminLoginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.issues[0].message });
    }
    const { email, password, totpCode, recoveryCode } = parsed.data;

    const result = await db.query(
      `SELECT id, email, full_name, password_hash, role, token_version,
              mfa_enabled, mfa_secret, mfa_last_timestep,
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
      await recordFailedAttempt(admin.id);
      return res.status(401).json({
        message: "Invalid email or password."
      });
    }

    // SEC-15.2: second factor. Deliberately placed AFTER the password check -
    // an attacker who does not know the password must never learn from the
    // response whether an account has MFA enrolled, so every wrong-password
    // attempt above returns the same generic 401 regardless of mfa_enabled.
    if (admin.mfa_enabled) {
      const submittedRecovery = typeof recoveryCode === "string" && recoveryCode.trim() !== "";
      const submittedTotp = typeof totpCode === "string" && totpCode.trim() !== "";

      if (!submittedRecovery && !submittedTotp) {
        // The one place enrollment state is disclosed, and only to a caller who
        // has already proved the password. Distinct from the generic 401 so the
        // dashboard knows to ask for a code rather than reporting bad
        // credentials. No token, partial or otherwise, is issued here.
        return res.status(401).json({
          code: "MFA_REQUIRED",
          message: "Enter the 6-digit code from your authenticator app."
        });
      }

      const accepted = submittedRecovery
        ? await adminMfaService.verifyRecoveryCode(admin, recoveryCode)
        : await adminMfaService.verifyTotp(admin, totpCode);

      if (!accepted) {
        // SEC-1.3 reuse: a wrong second factor counts toward the same
        // per-account lockout as a wrong password. Without this, the only
        // brute-force control on a 6-digit code would be the per-IP limiter,
        // which is in-memory (resets on every restart) and trivially spread
        // across addresses.
        await recordFailedAttempt(admin.id);
        return res.status(401).json({
          code: "MFA_INVALID",
          message: "That code is not valid. Please try again."
        });
      }
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
        // Authentication marker: "this is an admin token". Unchanged by
        // SEC-15.4 - adminAuthMiddleware and optionalAdminAuth both key off
        // this exact literal, and the OpenAPI contract pins it to an enum of
        // one value.
        role: "admin",
        // SEC-15.4 authorization tier, deliberately a SEPARATE claim. Folding
        // it into `role` would make one field answer both "is this an admin"
        // and "how much may it do", which is how those concerns get conflated.
        adminRole: admin.role,
        // SEC-15.3 (Phase 6): the session epoch, checked by
        // adminAuthMiddleware on every request. Until now an admin token in
        // the dashboard's localStorage could not be stopped before its 2h
        // `exp`, so an XSS bought the attacker the remainder of that window
        // with no way to intervene.
        tv: typeof admin.token_version === 'number' ? admin.token_version : 0
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
        role: "admin",
        // Returned so the dashboard can hide tabs the role cannot use. Purely
        // presentational - every decision is re-made server-side from the JWT.
        adminRole: admin.role
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

const USER_LIST_STATUSES = new Set(["active", "suspended", "banned", "deleted"]);
const USER_LIST_SORTS = {
  newest: `u.created_at DESC, u.id DESC`,
  oldest: `u.created_at ASC, u.id ASC`,
  risk: `COALESCE(r.score, 0) DESC, u.created_at DESC`,
};

/**
 * GET /api/admin/users?q=&status=&sort=&limit=&offset=
 *
 * The browsing counterpart to searchUserByEmail's exact-match lookup: the
 * Users page needs to page through and filter accounts, not just resolve one
 * email a support ticket already named. LEFT JOINs user_risk_scores (the same
 * table abuseFindingModel.topRisk reads) so the list can show a risk figure
 * per row without an N+1 follow-up call per user.
 */
async function listUsers(req, res) {
  try {
    const query = req.query || {};
    const limit = clampLimit(query.limit, { def: 25, max: 100 });
    const offset = Math.max(0, Math.floor(Number(query.offset)) || 0);

    const status = typeof query.status === "string" ? query.status : "all";
    if (status !== "all" && !USER_LIST_STATUSES.has(status)) {
      return res.status(400).json({ message: "status must be one of: all, active, suspended, banned, deleted." });
    }

    const sortKey = typeof query.sort === "string" && USER_LIST_SORTS[query.sort] ? query.sort : "newest";

    const where = [];
    const params = [];

    const q = typeof query.q === "string" ? query.q.trim() : "";
    if (q) {
      params.push(`%${q.toLowerCase()}%`);
      where.push(`(LOWER(u.email) LIKE $${params.length} OR LOWER(u.full_name) LIKE $${params.length})`);
    }
    if (status !== "all") {
      params.push(status);
      where.push(`u.status = $${params.length}`);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const listParams = [...params, limit, offset];
    const rows = await db.query(
      `SELECT u.id, u.email, u.full_name AS "fullName", u.status,
              u.created_at AS "createdAt", u.country_code AS "countryCode",
              u.balance, r.score AS "riskScore"
         FROM public.users u
         LEFT JOIN user_risk_scores r ON r.user_id = u.id
         ${whereSql}
        ORDER BY ${USER_LIST_SORTS[sortKey]}
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      listParams
    );

    const countRes = await db.query(
      `SELECT COUNT(*)::int AS total FROM public.users u ${whereSql}`,
      params
    );

    res.json({
      users: rows.rows,
      total: countRes.rows[0]?.total ?? 0,
      limit,
      offset,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Internal server error." });
  }
}

/**
 * GET /api/admin/users/:id
 *
 * The Users page drawer's single data source: profile, credits summary and
 * risk score in one call. Deliberately does NOT embed abuse findings or live
 * sessions - those already have their own endpoints
 * (GET /api/admin/abuse/findings?userId=, GET /api/admin/abuse/users/:id/sessions)
 * and duplicating that query here would be a second definition of the same
 * data. Credits history reuses walletService.getTransactionHistory verbatim
 * (the same function the mobile app's own wallet screen calls) rather than a
 * parallel SQL query, sliced to the most recent rows for a summary view.
 */
async function getUserDetail(req, res) {
  try {
    const { id } = req.params;

    const userRes = await db.query(
      `SELECT u.id, u.email, u.full_name AS "fullName", u.status,
              u.status_reason AS "statusReason", u.status_changed_at AS "statusChangedAt",
              u.created_at AS "createdAt", u.country_code AS "countryCode",
              u.balance, u.email_verified AS "emailVerified",
              r.score AS "riskScore", r.factors AS "riskFactors", r.computed_at AS "riskComputedAt"
         FROM public.users u
         LEFT JOIN user_risk_scores r ON r.user_id = u.id
        WHERE u.id = $1`,
      [id]
    );

    if (userRes.rows.length === 0) {
      return res.status(404).json({ message: "No user found with this id." });
    }

    const user = userRes.rows[0];
    const history = await walletService.getTransactionHistory(id);

    res.json({
      user,
      credits: {
        balance: user.balance,
        recentTransactions: history.slice(0, 10),
      },
    });
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

/**
 * POST /api/admin/users/:id/suspend      (SEC-18.2, Phase 6)
 * POST /api/admin/users/:id/reinstate
 *
 * Suspension that takes effect on the abuser's very NEXT request, not at their
 * next login. That distinction is the whole finding: an account worth
 * suspending is precisely the one that will never voluntarily re-authenticate,
 * so a status flag checked only at login would let a running session continue
 * spending credits and generating images for up to the full hour left on its
 * access token.
 *
 * Three writes make it immediate:
 *   1. status            - refused by authMiddleware, login, refresh, Google.
 *   2. token_version + 1 - every outstanding access token mismatches at once.
 *   3. family revocation - no refresh token can mint a replacement.
 *
 * Audit rows are written by the global auditAdminAction middleware, which
 * self-gates on req.admin + a mutating method + a 2xx response, so these
 * endpoints are recorded without registering anything per-route.
 */
const SUSPENDABLE_STATUSES = new Set(["suspended", "banned"]);

async function setUserStatus(req, res, { status, reason }) {
  const { id } = req.params;

  if (!/^[0-9a-fA-F-]{36}$/.test(id || "")) {
    return res.status(400).json({ message: "A valid user id is required." });
  }

  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");

    // Status and epoch move in ONE statement. Split across two, a crash
    // between them would leave an account marked suspended whose live tokens
    // still worked - the exact failure this endpoint exists to prevent.
    const updated = await client.query(
      `UPDATE public.users
       SET status = $1,
           status_reason = $2,
           status_changed_at = now(),
           status_changed_by = $3,
           token_version = token_version + 1,
           refresh_token_hash = NULL
       WHERE id = $4
       RETURNING id, email, status, token_version`,
      [status, reason || null, req.admin.id, id]
    );

    if (updated.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "No user found with this id." });
    }

    await sessionService.revokeAllUserRefreshTokens(
      id,
      status === "active" ? "admin_reinstate" : `admin_${status}`,
      client
    );

    await client.query("COMMIT");

    const row = updated.rows[0];
    return res.json({
      id: row.id,
      email: row.email,
      status: row.status,
      tokenVersion: row.token_version,
    });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch (_) { /* already failed */ }
    console.error("[admin] setUserStatus failed:", err.message);
    return res.status(500).json({ message: "Internal server error." });
  } finally {
    client.release();
  }
}

async function suspendUser(req, res) {
  const status = req.body && typeof req.body.status === "string" ? req.body.status : "suspended";
  if (!SUSPENDABLE_STATUSES.has(status)) {
    return res.status(400).json({ message: "status must be 'suspended' or 'banned'." });
  }
  const reason = req.body && typeof req.body.reason === "string" ? req.body.reason.slice(0, 500) : null;
  return setUserStatus(req, res, { status, reason });
}

async function reinstateUser(req, res) {
  // Reinstating also bumps token_version. It does not need to for security,
  // but it keeps one rule - "any status change ends existing sessions" -
  // instead of two, and a reinstated user signing in fresh is the clearer
  // outcome than one whose pre-suspension tokens quietly resume working.
  return setUserStatus(req, res, { status: "active", reason: null });
}

/**
 * POST /api/admin/users/:id/delete
 *
 * Account deletion, implemented as the SAME status-flip setUserStatus already
 * gives suspend/reinstate rather than a real SQL DELETE. A `DELETE FROM users`
 * would cascade into `profiles` and orphan wallet_transactions, creations and
 * abuse_findings rows that have no recovery path - see
 * migration_user_account_deletion.sql for the full reasoning. Reusing
 * setUserStatus means deletion gets the exact same guarantees suspension
 * already has for free: token_version bump, every refresh token revoked, and
 * the account is refused at the next request rather than at next login.
 */
async function deleteUser(req, res) {
  const reason = req.body && typeof req.body.reason === "string" ? req.body.reason.slice(0, 500) : null;
  return setUserStatus(req, res, { status: "deleted", reason });
}

module.exports = {
  login,
  searchUserByEmail,
  listUsers,
  getUserDetail,
  adjustUserBalance,
  suspendUser,
  reinstateUser,
  deleteUser,
};