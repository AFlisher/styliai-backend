const { z } = require('zod');
const {
  logAuditEvent,
  logAuthFailure,
  logUnexpectedError,
} = require("../utils/securityEvents");
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const db = require('../config/db');
const sendEmail = require('../utils/sendEmail');
const { renderVerificationPage, renderResetPasswordPage } = require('../utils/htmlTemplates');
const { passwordSchema, PASSWORD_POLICY_MESSAGE } = require('../utils/passwordPolicy');
const escapeHtml = require('../utils/escapeHtml');
const notificationModel = require('../models/notificationModel');
const { getCountryFromIp } = require('../utils/geoIp');
// SEC-18.3: keyed, irreversible origin key. Sits beside getCountryFromIp
// deliberately - they consume the same req.ip and it should be obvious at the
// import site that one produces analytics and the other produces a correlation
// key, and that neither stores the address.
const { originHashFor } = require('../utils/originHash');
// SEC-18.5: a coarse, bucketed client label - deliberately NOT the raw
// User-Agent, which is a fingerprinting surface far more precise than a
// session list needs. See utils/deviceLabel.js.
const { deviceLabelFor } = require('../utils/deviceLabel');
const sessionService = require('../services/sessionService');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_WEB_CLIENT_ID;
if (!GOOGLE_CLIENT_ID) {
  console.error("GOOGLE_WEB_CLIENT_ID is not configured — Google sign-in will not work.");
}
const googleOAuth2Client = new OAuth2Client(GOOGLE_CLIENT_ID);

// Helper to hash tokens with SHA-256 for secure database storage
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// SEC-1.6 (Phase 6): bcrypt cost for user passwords, raised 10 -> 12 to match
// the admin path (createAdmin.js and adminMfaService already use 12) and
// current guidance. Every bcrypt.hash call below reads this constant so the
// two can never drift.
//
// Existing users are NOT re-hashed in bulk - that is impossible, since the
// plaintext is not stored. They are upgraded transparently on their next
// successful login (see upgradePasswordHashIfNeeded), which is the only moment
// the plaintext legitimately exists in memory.
const BCRYPT_COST = 12;

// SEC-1.5: how long an email-verification link stays usable. 24h matches the
// audit's recommendation and the reset-token posture (1h) scaled to a flow
// where the user may not be at their mailbox immediately.
const VERIFICATION_TOKEN_TTL_HOURS = 24;

// SEC-1.2: dummy hash compared against when a login hits a non-existent or
// password-less (Google-only) account, so every login path performs the same
// bcrypt work and response timing can't be used to enumerate registered
// emails. Generated from 32 random bytes - no real password matches it - and
// the cost must stay equal to BCRYPT_COST above or the timing gap reopens
// (asserted in authController.security.test.js).
//
// Transitional caveat, stated because it is real: while legacy cost-10 hashes
// remain, comparing against one is roughly half the work of this cost-12
// dummy, so a not-yet-upgraded account answers marginally faster than an
// unknown email. The window closes per-account on first login. The
// alternative - pinning the dummy at 10 - would make unknown emails faster
// than every upgraded account instead, a gap that never closes.
const DUMMY_PASSWORD_HASH = '$2b$12$6zXPpKvOR.YYqDUCbq1F..m180euxyXpguKBNY9c3fdvmfQBOZlpa';

/**
 * SEC-1.6: transparent cost upgrade.
 *
 * Called only after a password has already been verified, so the plaintext in
 * hand is known-correct and this is the one moment a stronger hash can be
 * derived without asking the user for anything. Best-effort by design: a
 * failure here must never fail the login the user just passed, because the
 * cost of the old hash is a hardening concern and being unable to sign in is
 * an outage.
 */
async function upgradePasswordHashIfNeeded(userId, plaintext, storedHash) {
  try {
    if (typeof storedHash !== 'string') return;
    const cost = Number(storedHash.split('$')[2]);
    if (!Number.isFinite(cost) || cost >= BCRYPT_COST) return;

    const upgraded = await bcrypt.hash(plaintext, BCRYPT_COST);
    // Guarded on the hash we actually read, so a concurrent password change
    // between the compare and this write is not silently reverted.
    await db.query(
      'UPDATE public.users SET password_hash = $1 WHERE id = $2 AND password_hash = $3',
      [upgraded, userId, storedHash]
    );
  } catch (err) {
    console.error('[auth] password hash upgrade failed (login unaffected):', err.message);
  }
}

// SEC-1.3: per-account lockout bounds distributed brute-force that the
// per-IP loginLimiter can't (rotating IPs get a fresh budget each; the
// account itself previously had none). 5 consecutive failures lock the
// account for 15 minutes; success or password reset clears the counter,
// and an expired lock restores a fresh budget (handled atomically in the
// failure UPDATE below). While locked, login answers the same generic 401
// with the same dummy bcrypt work as every other rejection, so neither the
// response nor its timing reveals the lock (or the account's existence).
const MAX_FAILED_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

// Atomically increments the failure counter and derives the lock state in a
// single statement: all CASE expressions evaluate against the pre-update row
// under the row lock, and a blocked concurrent UPDATE re-evaluates against
// the newly committed row (READ COMMITTED re-check), so concurrent failures
// can never lose an increment or diverge counter and lock. An expired lock
// resets the budget: that failure counts as 1 with the lock cleared.
const RECORD_FAILED_LOGIN_SQL = `
  UPDATE public.users
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

// Validation schemas using Zod
const registerSchema = z.object({
  email: z.string().email("Invalid email format"),
  password: passwordSchema,
  fullName: z.string().min(1, "Full name is required")
});

const loginSchema = z.object({
  email: z.string().email("Invalid email format"),
  password: z.string().min(1, "Password is required")
});

const forgotPasswordSchema = z.object({
  email: z.string().email("Invalid email format")
});

const resetPasswordSchema = z.object({
  token: z.string().uuid("Invalid reset token format"),
  password: passwordSchema
});

// Helper to generate JWT access tokens signed with the Supabase JWT secret
function generateAccessToken(user) {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) {
    throw new Error("SUPABASE_JWT_SECRET is not configured on the server.");
  }
  
  // These claims match Supabase's authenticated user payload, enabling direct
  // DB/Storage RLS. The extra `type` claim (SEC-1.1) lets authMiddleware
  // distinguish access from refresh tokens; Supabase ignores unknown claims.
  //
  // R-3 constraint: the Flutter client injects this token into the Supabase
  // client, so sub/email/role/aud must never change shape. `tv` is an ADDITIVE
  // claim only, which is why revocation was implemented this way rather than
  // by restructuring the payload.
  const payload = {
    sub: user.id,
    email: user.email,
    role: 'authenticated',
    aud: 'authenticated',
    type: 'access',
    // Phase 6: the session epoch this token was minted at. authMiddleware
    // refuses the token once the stored counter moves past it. Defaults to 0
    // for any caller that did not select the column, matching the column
    // default and the middleware's treatment of an absent claim.
    tv: typeof user.token_version === 'number' ? user.token_version : 0
  };

  return jwt.sign(payload, secret, { expiresIn: '1h' });
}

// Helper to generate JWT refresh tokens
function generateRefreshToken(user) {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) {
    throw new Error("SUPABASE_JWT_SECRET is not configured on the server.");
  }

  // No `aud` claim here - authMiddleware requires `aud: 'authenticated'`, so
  // its absence is what keeps a refresh token unusable as an access token
  // (SEC-1.1). The `type` claim makes the distinction explicit going forward.
  // SEC-1.4 (Phase 6): 30d -> 14d. The JWT `exp` and the refresh_tokens row's
  // expires_at are set from the same constant and are two independent layers -
  // the JWT bounds it even if a row is somehow missed, the row bounds it even
  // if the signing key outlives a policy change.
  // `jti` is REQUIRED, not decorative. Without it the payload is only
  // { sub, type, iat, exp } and `iat` has one-second resolution, so two
  // refreshes for the same user inside the same second produce byte-identical
  // tokens. Under Phase 6 that is not a cosmetic collision: the token is the
  // PRIMARY KEY of refresh_tokens, so rotation would try to insert a row that
  // already exists AND the successor would hash-equal the row just marked
  // used - making the next legitimate refresh look exactly like a stolen-token
  // replay and revoking the user's whole family. A random id per token makes
  // every issued token distinct by construction.
  const payload = { sub: user.id, type: 'refresh', jti: uuidv4() };
  return jwt.sign(payload, secret, {
    expiresIn: `${sessionService.REFRESH_TOKEN_TTL_DAYS}d`
  });
}

// REGISTER endpoint
async function register(req, res) {
  let client;
  try {
    const validated = registerSchema.parse(req.body);
    
    // Check if user already exists
    const userCheck = await db.query('SELECT id FROM public.users WHERE email = $1', [validated.email.toLowerCase()]);
    if (userCheck.rows.length > 0) {
      return res.status(400).json({ message: "Email is already registered." });
    }

    const userId = uuidv4();
    const verificationToken = uuidv4();
    const passwordHash = await bcrypt.hash(validated.password, BCRYPT_COST);
    // SEC-1.5: verification links expire. Previously the token had no expiry
    // column at all, so a link mailed once stayed a valid account takeover
    // forever - an old mailbox compromise never stopped being exploitable.
    const verificationExpiresAt = new Date(Date.now() + VERIFICATION_TOKEN_TTL_HOURS * 3600 * 1000);

    // Resolve country from the request IP for analytics only; the IP itself is
    // still not stored. SEC-18.3 adds a KEYED HASH of it alongside - not the
    // address. HMAC(server_salt, ip) answers "how many accounts share this
    // origin" without retaining personal data or permitting reverse lookup,
    // which is the audit's own recommendation. Null when IP_HASH_SALT is unset
    // or the address is unresolvable; consumers must treat null as "unknown
    // origin" and never as a group key, or every unresolvable request would be
    // grouped into one fake cluster of unrelated accounts.
    const geo = getCountryFromIp(req.ip);
    const countryCode = geo ? geo.countryCode : null;
    const countryName = geo ? geo.countryName : null;
    const signupOriginHash = originHashFor(req);

    // Get a client from the pool for the transaction
    client = await db.pool.connect();

    // BEGIN transaction
    await client.query('BEGIN');

    // Save user inside PostgreSQL (public.users). Only the SHA-256 hash of
    // the verification token is stored, so a DB/backup leak can't be used to
    // verify arbitrary accounts - same handling as reset_token_hash.
    await client.query(`
      INSERT INTO public.users (id, full_name, email, password_hash, email_verified, verification_token_hash, verification_token_expires_at, provider, country_code, country_name, signup_origin_hash)
      VALUES ($1, $2, $3, $4, false, $5, $6, 'email', $7, $8, $9)
    `, [userId, validated.fullName, validated.email.toLowerCase(), passwordHash, hashToken(verificationToken), verificationExpiresAt, countryCode, countryName, signupOriginHash]);

    // Save corresponding profile inside public.profiles
    await client.query(`
      INSERT INTO public.profiles (id, full_name, email, provider)
      VALUES ($1, $2, $3, 'email')
    `, [userId, validated.fullName, validated.email.toLowerCase()]);

    // Seed the in-app notification feed - same transaction as the account
    // rows, so a new user never exists without their welcome notification.
    await notificationModel.createNotification({
      userId,
      type: 'welcome',
      title: 'Welcome to StyliAI',
      body: 'Start exploring styles and transform your photos.',
    }, client);

    // Send verification email using Resend
    const backendUrl = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 3000}`;
    const verificationLink = `${backendUrl}/api/auth/verify?token=${verificationToken}`;
    
    const emailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #05050A; color: #FFFFFF; border-radius: 12px; border: 1px solid #1E1E2F;">
        <h2 style="color: #A855F7; text-align: center;">Welcome to StyliAI!</h2>
        <p>Hello ${escapeHtml(validated.fullName)},</p>
        <p>Thank you for registering. Please confirm your email address by clicking the button below:</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${verificationLink}" style="background: linear-gradient(135deg, #A855F7, #E735F6); color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block; box-shadow: 0 4px 15px rgba(168, 85, 247, 0.4);">Verify Email Address</a>
        </div>
        <p style="color: #8A8A9D; font-size: 13px;">If you did not request this, please ignore this email.</p>
        <hr style="border-color: #1E1E2F; margin: 20px 0;" />
        <p style="font-size: 11px; color: #8A8A9D; text-align: center;">StyliAI — Apply Stunning Photo Styles</p>
      </div>
    `;

    try {
      await sendEmail({
        to: validated.email.toLowerCase(),
        subject: "Verify your email - StyliAI",
        html: emailHtml
      });
    } catch (emailErr) {
      console.error("Resend email sending failed during registration:", emailErr);
      throw new Error("verification_email_failed");
    }

    // COMMIT transaction if everything succeeded
    await client.query('COMMIT');
    logAuditEvent(req, { action: "registration", subject: userId });
    res.status(201).json({ message: "Registration successful. Please verify your email." });

  } catch (err) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        console.error("Error during transaction rollback:", rollbackErr);
      }
    }

    if (err instanceof z.ZodError) {
      return res.status(400).json({ message: err.issues[0].message });
    }
    
    if (err.message === "verification_email_failed") {
      return res.status(500).json({ 
        message: "Account was not created because the verification email could not be sent. Please try again." 
      });
    }

    logUnexpectedError(req, err, { where: "register" });
    res.status(500).json({ message: "An unexpected error occurred during registration." });
  } finally {
    if (client) {
      client.release();
    }
  }
}

// EMAIL VERIFICATION endpoint
async function verifyEmail(req, res) {
  const token = req.query.token;
  if (!token) {
    return res.status(400).send(renderVerificationPage({
      success: false,
      title: "Invalid Verification Link",
      subtitle: "The verification token is missing. Please check the link in your email."
    }));
  }

  try {
    // SEC-1.5: consume the token in ONE conditional statement rather than
    // SELECT-then-UPDATE. Two properties come from that single write:
    //
    //   expiry     - `verification_token_expires_at > now()` is evaluated by
    //                the database, on the same clock that wrote it, so app/DB
    //                skew cannot widen the window.
    //   one-time   - only one caller can match a row whose hash is still set,
    //                because the same statement clears it. A replayed link,
    //                including two concurrent clicks of the same link, finds
    //                nothing to match on the second attempt.
    //
    // NULL expiry is treated as expired, deliberately. The migration
    // backfilled a fresh 24h window onto every pending token at deploy, so a
    // NULL here means a token written by a path that forgot to set one - it
    // should fail closed rather than resurrect the unbounded-lifetime bug.
    const result = await db.query(
      `UPDATE public.users
       SET email_verified = true,
           verification_token_hash = NULL,
           verification_token_expires_at = NULL
       WHERE verification_token_hash = $1
         AND verification_token_expires_at IS NOT NULL
         AND verification_token_expires_at > now()
       RETURNING id`,
      [hashToken(token)]
    );

    if (result.rows.length === 0) {
      // Invalid, expired and already-used are deliberately one response: the
      // distinction would tell an attacker holding a leaked link whether the
      // account exists and whether it has been claimed.
      return res.status(400).send(renderVerificationPage({
        success: false,
        title: "Verification Failed",
        subtitle: "The verification link is invalid, expired, or has already been used."
      }));
    }

    const user = result.rows[0];

    logAuditEvent(req, { action: "email_verification", subject: user.id });

    res.send(renderVerificationPage({
      success: true,
      title: "Email Verified Successfully",
      subtitle: "Your email has been verified successfully.<br/><br/>You can now return to the StyliAI app and sign in."
    }));

  } catch (err) {
    logUnexpectedError(req, err, { where: "verifyEmail" });
    res.status(500).send(renderVerificationPage({
      success: false,
      title: "Server Error",
      subtitle: "An error occurred on the server. Please try again later."
    }));
  }
}

// LOGIN endpoint
async function login(req, res) {
  try {
    const validated = loginSchema.parse(req.body);

    // is_locked is computed DB-side so it uses the same clock (now()) that
    // wrote locked_until, keeping app/DB clock skew out of the decision.
    const userRes = await db.query(
      `SELECT id, email, full_name, password_hash, email_verified, created_at,
              token_version, status,
              (locked_until IS NOT NULL AND locked_until > now()) AS is_locked
       FROM public.users WHERE email = $1`,
      [validated.email.toLowerCase()]
    );

    if (userRes.rows.length === 0) {
      // SEC-1.2: burn the same bcrypt work as a real comparison before the
      // generic 401, so a timing probe can't distinguish this path.
      await bcrypt.compare(validated.password, DUMMY_PASSWORD_HASH);
      // The response is deliberately identical for every failure branch
      // (SEC-1.2/1.3); only the server-side log tells them apart, which is
      // exactly where that distinction is safe to make.
      logAuthFailure(req, { reason: "unknown_email" });
      return res.status(401).json({ message: "Invalid email or password." });
    }

    const user = userRes.rows[0];

    // SEC-1.3: locked account. Same generic 401 and same dummy bcrypt work
    // as every other rejection - the real hash is deliberately never
    // evaluated while locked, and neither response nor timing reveals the
    // lock. No counter update here: probes during a lock don't extend it.
    if (user.is_locked) {
      await bcrypt.compare(validated.password, DUMMY_PASSWORD_HASH);
      return res.status(401).json({ message: "Invalid email or password." });
    }

    // Google-only accounts have no password hash - reject with the same
    // generic 401 instead of letting bcrypt.compare throw a 500, and with the
    // same dummy bcrypt work so timing doesn't reveal the provider (SEC-1.2).
    if (!user.password_hash) {
      await bcrypt.compare(validated.password, DUMMY_PASSWORD_HASH);
      return res.status(401).json({ message: "Invalid email or password." });
    }

    // Compare passwords
    const match = await bcrypt.compare(validated.password, user.password_hash);
    if (!match) {
      // SEC-1.3: count the failure and lock the account at the threshold.
      const failRes = await db.query(RECORD_FAILED_LOGIN_SQL, [user.id]);
      const updated = failRes.rows[0];
      if (updated && updated.failed_login_attempts === MAX_FAILED_LOGIN_ATTEMPTS && updated.locked_until) {
        // Alerting placeholder until security-event logging (SEC-16.3)
        // exists. User id only - no email/PII in logs (Section 16).
        logAuthFailure(req, { reason: "account_locked_threshold_reached", subject: user.id });
      }
      return res.status(401).json({ message: "Invalid email or password." });
    }

    // SEC-18.2: a suspended account cannot start a new session either. Placed
    // AFTER the password check on purpose - answering "this account is
    // suspended" to an unauthenticated guess would turn the endpoint into an
    // oracle for which emails are registered and which are in trouble.
    if (user.status !== sessionService.ACTIVE_STATUS) {
      logAuthFailure(req, { reason: "account_not_active", subject: user.id });
      return res.status(403).json({
        message: "This account has been suspended. Please contact support.",
        code: "ACCOUNT_SUSPENDED"
      });
    }

    // Check email verification status
    if (!user.email_verified) {
      return res.status(403).json({ message: "Please verify your email before signing in." });
    }

    // SEC-1.6: now that the password is known correct, upgrade a legacy
    // cost-10 hash in place. Awaited so a login immediately followed by
    // another observes the upgraded hash, but non-fatal inside.
    await upgradePasswordHashIfNeeded(user.id, validated.password, user.password_hash);

    // Generate JWT access + refresh tokens
    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user);

    // SEC-1.4: a login starts a NEW refresh family. Families are per-login, so
    // signing in on a second device does not disturb the first - and a theft
    // detected on one device revokes only that chain, unless the reuse
    // response escalates to a full account-wide revocation.
    // SEC-18.5: record WHERE this session started. A login is the only moment
    // request context is available for a session - the rotation path has none -
    // so this is where the signal has to be captured.
    await sessionService.recordRefreshToken({
      userId: user.id,
      token: refreshToken,
      originHash: originHashFor(req),
      deviceLabel: deviceLabelFor(req),
    });

    // A successful login restores the full failed-attempt budget (SEC-1.3).
    // refresh_token_hash is no longer written here: the refresh_tokens table
    // is the record now, and leaving a stale value in the legacy column would
    // keep a superseded token alive through the migration fallback.
    await db.query(
      'UPDATE public.users SET refresh_token_hash = NULL, failed_login_attempts = 0, locked_until = NULL WHERE id = $1',
      [user.id]
    );

    logAuditEvent(req, { action: "login", subject: user.id, details: { method: "password" } });

    res.json({
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.full_name,
        emailConfirmedAt: user.created_at // Use created_at as an indicator of verification timestamp
      }
    });

  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ message: err.issues[0].message });
    }
    logUnexpectedError(req, err, { where: "login" });
    res.status(500).json({ message: "An unexpected error occurred." });
  }
}

// REFRESH TOKEN endpoint
async function refreshToken(req, res) {
  const { refreshToken } = req.body;
  if (!refreshToken) {
    return res.status(400).json({ message: "Refresh token is required." });
  }

  try {
    const secret = process.env.SUPABASE_JWT_SECRET;
    const decoded = jwt.verify(refreshToken, secret, { algorithms: ['HS256'] });

    // SEC-1.1: reject an access token presented as a refresh token (access
    // tokens carry `aud`/`type:'access'`; refresh tokens never have `aud`).
    // Legacy refresh tokens without a `type` claim stay accepted so sessions
    // issued before this change survive the rollout.
    if (decoded.aud !== undefined || decoded.type === 'access') {
      return res.status(401).json({ message: "Invalid or expired refresh token." });
    }

    const userRes = await db.query(
      `SELECT id, email, full_name, refresh_token_hash, created_at, token_version, status
       FROM public.users WHERE id = $1`,
      [decoded.sub]
    );

    if (userRes.rows.length === 0) {
      return res.status(401).json({ message: "User not found." });
    }

    let user = userRes.rows[0];

    // SEC-18.2: a suspended account cannot mint fresh credentials. Checked
    // here as well as in the middleware because refresh is the one endpoint
    // whose entire purpose is to hand out a new access token.
    if (user.status !== sessionService.ACTIVE_STATUS) {
      logAuthFailure(req, { reason: "account_not_active", subject: user.id });
      return res.status(403).json({
        message: "This account has been suspended. Please contact support.",
        code: "ACCOUNT_SUSPENDED"
      });
    }

    // SEC-1.4: rotation with reuse detection.
    const consumption = await sessionService.consumeRefreshToken(refreshToken);
    let familyId = consumption.familyId;

    if (consumption.outcome === 'reuse') {
      // The decisive case. This exact token was already exchanged, so two
      // parties hold it: the legitimate client (which rotated and moved on)
      // and whoever obtained a copy. Which of the two is presenting it now is
      // unknowable, so the only safe response is to end the session for both
      // and force a fresh authentication.
      //
      // Revoking the family alone would leave the thief's already-issued
      // ACCESS token working for up to an hour, so token_version is bumped
      // too - that is what makes this a real containment rather than a
      // partial one.
      await sessionService.revokeRefreshFamily(familyId, 'reuse_detected');
      await sessionService.bumpUserTokenVersion(user.id);
      logAuthFailure(req, { reason: "refresh_token_reuse_detected", subject: user.id });
      logAuditEvent(req, {
        action: "refresh_reuse_revocation",
        outcome: "failure",
        subject: user.id,
      });
      return res.status(401).json({
        message: "Session has been revoked. Please sign in again.",
        code: "SESSION_REVOKED"
      });
    }

    if (consumption.outcome !== 'consumed') {
      // 'unknown' may be a pre-Phase-6 session whose only record is the legacy
      // column. Accept it exactly once and migrate it into a family, so this
      // deploy does not sign out every existing user. Removable once the
      // longest legacy token (30d) has expired - see the migration.
      const migrated = consumption.outcome === 'unknown'
        && await sessionService.consumeLegacyRefreshToken(user.id, refreshToken);

      if (!migrated) {
        // 'revoked' and 'expired' are reported identically to 'unknown': the
        // client's only useful action in all three cases is to sign in again.
        return res.status(401).json({ message: "Invalid or expired refresh token." });
      }
      familyId = undefined; // start a fresh family for the migrated session
    }

    // Issue new access + refresh tokens. The access token is minted from the
    // row read above, so it carries the CURRENT token_version - a refresh
    // performed after a revocation elsewhere cannot mint a stale-epoch token.
    const newAccessToken = generateAccessToken(user);
    const newRefreshToken = generateRefreshToken(user);

    await sessionService.recordRefreshToken({
      userId: user.id,
      token: newRefreshToken,
      familyId,
    });

    res.json({
      accessToken: newAccessToken,
      refreshToken: newRefreshToken
    });

  } catch (err) {
    console.error("Refresh token error:", err.message);
    return res.status(401).json({ message: "Invalid or expired refresh token." });
  }
}

// FORGOT PASSWORD endpoint
async function forgotPassword(req, res) {
  try {
    const validated = forgotPasswordSchema.parse(req.body);

    const userRes = await db.query('SELECT id, full_name FROM public.users WHERE email = $1', [validated.email.toLowerCase()]);

    // Only generate a token and send an email if the account actually exists,
    // but respond identically either way below so this endpoint can't be used
    // to enumerate registered emails.
    if (userRes.rows.length > 0) {
      const user = userRes.rows[0];
      const resetToken = uuidv4();
      const resetTokenHash = hashToken(resetToken);
      // Link expires in 1 hour
      const expiresAt = new Date(Date.now() + 3600 * 1000);

      await db.query(
        'UPDATE public.users SET reset_token_hash = $1, reset_token_expires_at = $2 WHERE id = $3',
        [resetTokenHash, expiresAt, user.id]
      );

      const backendUrl = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 3000}`;
      const resetLink = `${backendUrl}/api/auth/reset-password?token=${resetToken}`;

      const emailHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #05050A; color: #FFFFFF; border-radius: 12px; border: 1px solid #1E1E2F;">
          <h2 style="color: #E735F6; text-align: center;">Reset Your Password</h2>
          <p>Hello ${escapeHtml(user.full_name)},</p>
          <p>We received a request to reset your password. Click the button below to choose a new password. This link is valid for 1 hour.</p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${resetLink}" style="background: linear-gradient(135deg, #A855F7, #E735F6); color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block; box-shadow: 0 4px 15px rgba(231, 53, 246, 0.4);">Reset Password</a>
          </div>
          <p style="color: #8A8A9D; font-size: 13px;">If you did not request a password reset, please ignore this email.</p>
          <hr style="border-color: #1E1E2F; margin: 20px 0;" />
          <p style="font-size: 11px; color: #8A8A9D; text-align: center;">StyliAI — Apply Stunning Photo Styles</p>
        </div>
      `;

      await sendEmail({
        to: validated.email.toLowerCase(),
        subject: "Reset your password - StyliAI",
        html: emailHtml
      });
    }

    res.json({ message: "If an account with this email exists, a password reset link has been sent." });

  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ message: err.issues[0].message });
    }
    logUnexpectedError(req, err, { where: "forgotPassword" });
    res.status(500).json({ message: "An unexpected error occurred." });
  }
}

// RENDER RESET PASSWORD form (GET)
async function renderResetPassword(req, res) {
  const token = req.query.token;
  if (!token) {
    return res.status(400).send(renderResetPasswordPage({
      error: "Reset token is missing. Please request a new password reset link."
    }));
  }

  try {
    const hashed = hashToken(token);
    const userRes = await db.query(
      'SELECT id, reset_token_expires_at FROM public.users WHERE reset_token_hash = $1',
      [hashed]
    );

    if (userRes.rows.length === 0) {
      return res.status(400).send(renderResetPasswordPage({
        error: "The reset link is invalid, expired, or has already been used."
      }));
    }

    const user = userRes.rows[0];
    if (new Date() > new Date(user.reset_token_expires_at)) {
      return res.status(400).send(renderResetPasswordPage({
        error: "This password reset link has expired. Please request a new one."
      }));
    }

    res.send(renderResetPasswordPage({ token }));

  } catch (err) {
    logUnexpectedError(req, err, { where: "renderResetPassword" });
    res.status(500).send(renderResetPasswordPage({
      error: "A server error occurred. Please try again later."
    }));
  }
}

// PROCESS RESET PASSWORD form (POST)
async function postResetPassword(req, res) {
  try {
    const validated = resetPasswordSchema.parse(req.body);
    const hashed = hashToken(validated.token);

    // Phase 6: consume the reset token in the SAME statement that sets the new
    // password. Previously this was SELECT (check hash) -> check expiry in JS
    // -> UPDATE, which leaves a window where two concurrent submissions of one
    // link both pass the check and both set a password - the second attacker
    // wins. Matching on the hash inside the write makes the link strictly
    // one-time, and `reset_token_expires_at > now()` puts expiry on the
    // database's clock rather than the app's.
    //
    // The same statement bumps token_version and the refresh families are
    // revoked immediately after, so a session the attacker already holds dies
    // with the old password instead of surviving up to an hour on its access
    // token. Password reset is the account-recovery path, so it also clears
    // any login lockout (SEC-1.3) - a locked-out owner regains access at once.
    const newPasswordHash = await bcrypt.hash(validated.password, BCRYPT_COST);
    const updated = await db.query(
      `UPDATE public.users
       SET password_hash = $1,
           reset_token_hash = NULL,
           reset_token_expires_at = NULL,
           refresh_token_hash = NULL,
           failed_login_attempts = 0,
           locked_until = NULL,
           token_version = token_version + 1
       WHERE reset_token_hash = $2
         AND reset_token_expires_at IS NOT NULL
         AND reset_token_expires_at > now()
       RETURNING id`,
      [newPasswordHash, hashed]
    );

    if (updated.rows.length === 0) {
      // Invalid, expired and already-consumed collapse into one response for
      // the same reason as email verification: separating them tells a holder
      // of a leaked link something about the account.
      return res.status(400).send(renderResetPasswordPage({
        error: "The reset link is invalid, expired, or has already been used."
      }));
    }

    const user = updated.rows[0];
    await sessionService.revokeAllUserRefreshTokens(user.id, 'password_reset');

    logAuditEvent(req, { action: "password_reset", subject: user.id });

    res.send(renderVerificationPage({
      success: true,
      title: "Password Reset Success",
      subtitle: "Your password has been reset successfully.<br/><br/>You can now open the StyliAI app and log in with your new password."
    }));

  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).send(renderResetPasswordPage({
        token: req.body.token,
        error: err.issues[0].message
      }));
    }
    logUnexpectedError(req, err, { where: "postResetPassword" });
    res.status(500).send(renderResetPasswordPage({
      error: "An error occurred on the server. Please try again."
    }));
  }
}

// CHECK VERIFICATION STATUS endpoint
async function checkVerificationStatus(req, res) {
  const email = req.query.email;
  if (!email) {
    return res.status(400).json({ message: "Email is required." });
  }

  try {
    const result = await db.query(
      'SELECT email_verified FROM public.users WHERE email = $1',
      [email.toLowerCase()]
    );

    // Non-existent accounts report as unverified rather than a distinct 404,
    // so this endpoint can't be used to enumerate registered emails.
    const verified = result.rows.length > 0 ? result.rows[0].email_verified : false;
    res.json({ verified });
  } catch (err) {
    logUnexpectedError(req, err, { where: "checkVerificationStatus" });
    res.status(500).json({ message: "Server error." });
  }
}

// RESEND VERIFICATION email endpoint
async function resendVerification(req, res) {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ message: "Email is required." });
  }

  try {
    const userRes = await db.query(
      'SELECT id, full_name, email_verified FROM public.users WHERE email = $1',
      [email.toLowerCase()]
    );

    // Only send an email if the account exists and is still unverified, but
    // respond identically in every other case (nonexistent account, already
    // verified) so this endpoint can't be used to enumerate registered emails
    // or their verification status.
    if (userRes.rows.length > 0 && !userRes.rows[0].email_verified) {
      const user = userRes.rows[0];
      // Only the hash is stored, so the original token can't be re-sent -
      // issue a fresh one on every resend (also invalidates older links).
      const token = uuidv4();
      // SEC-1.5: a resend issues a fresh token AND a fresh 24h window. Without
      // the expiry written here, the resend path would keep minting the
      // unbounded-lifetime tokens this finding is about.
      const resendExpiresAt = new Date(Date.now() + VERIFICATION_TOKEN_TTL_HOURS * 3600 * 1000);
      await db.query(
        'UPDATE public.users SET verification_token_hash = $1, verification_token_expires_at = $2 WHERE id = $3',
        [hashToken(token), resendExpiresAt, user.id]
      );

      const backendUrl = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 3000}`;
      const verificationLink = `${backendUrl}/api/auth/verify?token=${token}`;

      const emailHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #05050A; color: #FFFFFF; border-radius: 12px; border: 1px solid #1E1E2F;">
          <h2 style="color: #A855F7; text-align: center;">Verify Your Email</h2>
          <p>Hello ${escapeHtml(user.full_name)},</p>
          <p>Please confirm your email address by clicking the button below:</p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${verificationLink}" style="background: linear-gradient(135deg, #A855F7, #E735F6); color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">Verify Email Address</a>
          </div>
          <hr style="border-color: #1E1E2F; margin: 20px 0;" />
          <p style="font-size: 11px; color: #8A8A9D; text-align: center;">StyliAI — Apply Stunning Photo Styles</p>
        </div>
      `;

      await sendEmail({
        to: email.toLowerCase(),
        subject: "Verify your email - StyliAI",
        html: emailHtml
      });
    }

    res.json({ message: "If an account with this email exists and is unverified, a verification link has been sent." });

  } catch (err) {
    logUnexpectedError(req, err, { where: "resendVerification" });
    res.status(500).json({ message: "Server error." });
  }
}

// GOOGLE SIGN-IN endpoint
async function googleSignIn(req, res) {
  try {
    const { idToken } = req.body;
    if (!idToken) {
      return res.status(400).json({ message: 'Google ID token is required.' });
    }

    // Verify the Google ID token
    let ticket;
    try {
      ticket = await googleOAuth2Client.verifyIdToken({
        idToken,
        audience: GOOGLE_CLIENT_ID,
      });
    } catch (verifyErr) {
      console.error('Google token verification failed:', verifyErr.message);
      return res.status(401).json({ message: 'Invalid Google ID token.' });
    }

    const payload = ticket.getPayload();
    const googleId = payload.sub;
    // Tokens minted without the email scope have no email claim - reject
    // cleanly instead of crashing on .toLowerCase().
    if (!payload.email) {
      return res.status(401).json({ message: 'Google account did not provide an email address.' });
    }
    const email = payload.email.toLowerCase();
    const fullName = payload.name || payload.email.split('@')[0];
    const avatarUrl = payload.picture || null;

    let user;

    // 1) Look up by google_id
    const byGoogleId = await db.query(
      'SELECT id, email, full_name, created_at, token_version, status FROM public.users WHERE google_id = $1',
      [googleId]
    );

    if (byGoogleId.rows.length > 0) {
      // Existing Google user — just log in
      user = byGoogleId.rows[0];
    } else {
      // 2) Look up by email
      const byEmail = await db.query(
        'SELECT id, email, full_name, avatar_url, created_at, token_version, status FROM public.users WHERE email = $1',
        [email]
      );

      if (byEmail.rows.length > 0) {
        // Existing email/password user — link Google account
        const existing = byEmail.rows[0];
        const updatedAvatar = existing.avatar_url || avatarUrl;
        await db.query(
          `UPDATE public.users
           SET google_id = $1, provider = 'google', email_verified = true, avatar_url = $2
           WHERE id = $3`,
          [googleId, updatedAvatar, existing.id]
        );
        await db.query(
          `UPDATE public.profiles
           SET provider = 'google'
           WHERE id = $1`,
          [existing.id]
        );
        user = existing;
      } else {
        // 3) New user — create account
        const userId = uuidv4();

        // Same as the email path: country for analytics, plus SEC-18.3's keyed
        // origin hash. This path matters MORE for correlation, not less - it
        // produces an instantly-verified account with no email round-trip
        // (SEC-18.4), so it is the cheaper of the two to farm.
        const geo = getCountryFromIp(req.ip);
        const countryCode = geo ? geo.countryCode : null;
        const countryName = geo ? geo.countryName : null;
        const signupOriginHash = originHashFor(req);

        await db.query(
          `INSERT INTO public.users
             (id, full_name, email, password_hash, email_verified, google_id, provider, avatar_url, country_code, country_name, signup_origin_hash)
           VALUES ($1, $2, $3, NULL, true, $4, 'google', $5, $6, $7, $8)`,
          [userId, fullName, email, googleId, avatarUrl, countryCode, countryName, signupOriginHash]
        );

        // Create matching profile row
        await db.query(
          `INSERT INTO public.profiles (id, full_name, email, provider, avatar_url)
           VALUES ($1, $2, $3, 'google', $4)`,
          [userId, fullName, email, avatarUrl]
        );

        // Best-effort welcome notification (this path isn't transactional
        // like email registration; sign-in must not fail over a feed row).
        try {
          await notificationModel.createNotification({
            userId,
            type: 'welcome',
            title: 'Welcome to StyliAI',
            body: 'Start exploring styles and transform your photos.',
          });
        } catch (notifErr) {
          console.error('[googleSignIn] Failed to create welcome notification:', notifErr.message);
        }

        const newUserRes = await db.query(
          'SELECT id, email, full_name, created_at, token_version, status FROM public.users WHERE id = $1',
          [userId]
        );
        user = newUserRes.rows[0];
      }
    }

    // SEC-18.2: suspension applies to Google sign-in too. A provider that
    // vouches for the identity says nothing about whether this service still
    // permits the account.
    if (user.status !== undefined && user.status !== sessionService.ACTIVE_STATUS) {
      logAuthFailure(req, { reason: "account_not_active", subject: user.id });
      return res.status(403).json({
        message: "This account has been suspended. Please contact support.",
        code: "ACCOUNT_SUSPENDED"
      });
    }

    // Generate JWT access + refresh tokens (same as email login)
    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user);

    // SEC-1.4: same family bookkeeping as password login - this path must not
    // be a way to obtain a refresh token that reuse detection cannot see.
    // SEC-18.5: and, for the same reason, not a way to obtain a session that
    // concurrent-use detection cannot see either.
    await sessionService.recordRefreshToken({
      userId: user.id,
      token: refreshToken,
      originHash: originHashFor(req),
      deviceLabel: deviceLabelFor(req),
    });
    await db.query(
      'UPDATE public.users SET refresh_token_hash = NULL WHERE id = $1',
      [user.id]
    );

    res.json({
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.full_name,
        emailConfirmedAt: user.created_at,
      },
    });

  } catch (err) {
    logUnexpectedError(req, err, { where: "googleSignIn" });
    res.status(500).json({ message: 'An unexpected error occurred during Google sign-in.' });
  }
}

// CHANGE PASSWORD endpoint
async function changePassword(req, res) {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: "Current password and new password are required." });
    }

    const policyCheck = passwordSchema.safeParse(newPassword);
    if (!policyCheck.success) {
      return res.status(400).json({ message: PASSWORD_POLICY_MESSAGE });
    }

    const userId = req.user.id;
    const userRes = await db.query(
      'SELECT id, email, full_name, password_hash, provider FROM public.users WHERE id = $1',
      [userId]
    );

    if (userRes.rows.length === 0) {
      return res.status(404).json({ message: "User not found." });
    }

    const user = userRes.rows[0];

    // If Google account
    if (user.provider === 'google') {
      return res.status(400).json({ message: "Password cannot be changed for accounts registered via Google Sign-In." });
    }

    // Verify current password
    const match = await bcrypt.compare(currentPassword, user.password_hash);
    if (!match) {
      return res.status(400).json({ message: "Incorrect current password." });
    }

    // Phase 6: a password change now invalidates ACCESS tokens too.
    //
    // Previously it rotated refresh_token_hash only, so another device kept
    // full API access for up to an hour after the owner changed their password
    // specifically to lock that device out - the window in which the change
    // felt effective but was not. Bumping token_version closes it at once.
    //
    // Order matters: bump first, then mint. The new pair is issued from the
    // post-bump version so the caller's own session survives, which is what
    // makes this usable without signing the user out of the device they are
    // holding.
    const newHash = await bcrypt.hash(newPassword, BCRYPT_COST);
    const bumpRes = await db.query(
      `UPDATE public.users
       SET password_hash = $1, refresh_token_hash = NULL, token_version = token_version + 1
       WHERE id = $2
       RETURNING token_version`,
      [newHash, userId]
    );
    await sessionService.revokeAllUserRefreshTokens(userId, 'password_change');

    const rotatedUser = { ...user, token_version: bumpRes.rows[0].token_version };
    const newAccessToken = generateAccessToken(rotatedUser);
    const newRefreshToken = generateRefreshToken(rotatedUser);
    await sessionService.recordRefreshToken({ userId, token: newRefreshToken });

    logAuditEvent(req, { action: "password_change", subject: userId });

    res.json({
      message: "Password changed successfully.",
      accessToken: newAccessToken,
      refreshToken: newRefreshToken
    });

  } catch (err) {
    logUnexpectedError(req, err, { where: "changePassword" });
    res.status(500).json({ message: "An unexpected error occurred." });
  }
}

// LOGOUT endpoint (this device)
async function logout(req, res) {
  try {
    // Revoke the refresh tokens server-side so a copy an attacker may hold
    // (device compromise, log leak, etc.) stops working the moment the user
    // logs out, instead of remaining valid for its full lifetime.
    //
    // Deliberately does NOT bump token_version. Logout is per-device by
    // design, and a bump would sign the user out of every other device too -
    // surprising behaviour for a button labelled "log out". The remaining
    // access token on THIS device is discarded by the client and expires
    // within the hour; a user who needs the stronger guarantee has
    // /logout-all, which states what it does.
    await sessionService.revokeAllUserRefreshTokens(req.user.id, 'logout');
    await db.query(
      'UPDATE public.users SET refresh_token_hash = NULL WHERE id = $1',
      [req.user.id]
    );
    logAuditEvent(req, { action: "logout", subject: req.user.id });
    return res.status(204).send();
  } catch (err) {
    logUnexpectedError(req, err, { where: "logout" });
    return res.status(500).json({ message: "An unexpected error occurred." });
  }
}

// LOGOUT EVERYWHERE endpoint (Phase 6)
async function logoutAll(req, res) {
  try {
    // The user-facing half of the revocation mechanism: "sign me out of every
    // device", the standard response to a lost or stolen phone. Bumping
    // token_version kills every outstanding ACCESS token immediately -
    // including the one making this request, which is correct and intended.
    // The client must sign in again afterwards.
    await sessionService.revokeAllUserRefreshTokens(req.user.id, 'logout_all');
    const newVersion = await sessionService.bumpUserTokenVersion(req.user.id);
    await db.query(
      'UPDATE public.users SET refresh_token_hash = NULL WHERE id = $1',
      [req.user.id]
    );

    logAuditEvent(req, {
      action: "logout_all",
      subject: req.user.id,
      details: { tokenVersion: newVersion },
    });
    return res.status(204).send();
  } catch (err) {
    logUnexpectedError(req, err, { where: "logoutAll" });
    return res.status(500).json({ message: "An unexpected error occurred." });
  }
}

module.exports = {
  register,
  verifyEmail,
  login,
  refreshToken,
  forgotPassword,
  renderResetPassword,
  postResetPassword,
  checkVerificationStatus,
  resendVerification,
  googleSignIn,
  changePassword,
  logout,
  logoutAll,
};
