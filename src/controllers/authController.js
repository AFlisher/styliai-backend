const { z } = require('zod');
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

const GOOGLE_CLIENT_ID = process.env.GOOGLE_WEB_CLIENT_ID;
if (!GOOGLE_CLIENT_ID) {
  console.error("GOOGLE_WEB_CLIENT_ID is not configured — Google sign-in will not work.");
}
const googleOAuth2Client = new OAuth2Client(GOOGLE_CLIENT_ID);

// Helper to hash tokens with SHA-256 for secure database storage
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

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
  
  // These claims match Supabase's authenticated user payload, enabling direct DB/Storage RLS
  const payload = {
    sub: user.id,
    email: user.email,
    role: 'authenticated',
    aud: 'authenticated'
  };

  return jwt.sign(payload, secret, { expiresIn: '1h' });
}

// Helper to generate JWT refresh tokens
function generateRefreshToken(user) {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) {
    throw new Error("SUPABASE_JWT_SECRET is not configured on the server.");
  }

  const payload = { sub: user.id };
  return jwt.sign(payload, secret, { expiresIn: '30d' });
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
    const passwordHash = await bcrypt.hash(validated.password, 10);

    // Resolve country from the request IP for analytics only; the IP itself is not stored.
    const geo = getCountryFromIp(req.ip);
    const countryCode = geo ? geo.countryCode : null;
    const countryName = geo ? geo.countryName : null;
    // TEMPORARY DIAGNOSTIC - remove after wrong-country investigation (see /api/_debug/ip-check in app.js)
    console.log('[geoip-debug][register]', JSON.stringify({
      reqIp: req.ip, reqIps: req.ips,
      xForwardedFor: req.headers?.['x-forwarded-for'] || null,
      xRealIp: req.headers?.['x-real-ip'] || null,
      socketRemoteAddress: req.socket?.remoteAddress || null,
      geo,
    }));

    // Get a client from the pool for the transaction
    client = await db.pool.connect();

    // BEGIN transaction
    await client.query('BEGIN');

    // Save user inside PostgreSQL (public.users). Only the SHA-256 hash of
    // the verification token is stored, so a DB/backup leak can't be used to
    // verify arbitrary accounts - same handling as reset_token_hash.
    await client.query(`
      INSERT INTO public.users (id, full_name, email, password_hash, email_verified, verification_token_hash, provider, country_code, country_name)
      VALUES ($1, $2, $3, $4, false, $5, 'email', $6, $7)
    `, [userId, validated.fullName, validated.email.toLowerCase(), passwordHash, hashToken(verificationToken), countryCode, countryName]);

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

    console.error("Registration error:", err);
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
    const result = await db.query(
      'SELECT id, email_verified FROM public.users WHERE verification_token_hash = $1',
      [hashToken(token)]
    );

    if (result.rows.length === 0) {
      return res.status(400).send(renderVerificationPage({
        success: false,
        title: "Verification Failed",
        subtitle: "The verification link is invalid, expired, or has already been used."
      }));
    }

    const user = result.rows[0];

    // Verify user and clear the token
    await db.query(
      'UPDATE public.users SET email_verified = true, verification_token_hash = NULL WHERE id = $1',
      [user.id]
    );

    res.send(renderVerificationPage({
      success: true,
      title: "Email Verified Successfully",
      subtitle: "Your email has been verified successfully.<br/><br/>You can now return to the StyliAI app and sign in."
    }));

  } catch (err) {
    console.error("Verification error:", err);
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

    const userRes = await db.query(
      'SELECT id, email, full_name, password_hash, email_verified, created_at FROM public.users WHERE email = $1',
      [validated.email.toLowerCase()]
    );

    if (userRes.rows.length === 0) {
      return res.status(401).json({ message: "Invalid email or password." });
    }

    const user = userRes.rows[0];

    // Google-only accounts have no password hash - reject with the same
    // generic 401 instead of letting bcrypt.compare throw a 500.
    if (!user.password_hash) {
      return res.status(401).json({ message: "Invalid email or password." });
    }

    // Compare passwords
    const match = await bcrypt.compare(validated.password, user.password_hash);
    if (!match) {
      return res.status(401).json({ message: "Invalid email or password." });
    }

    // Check email verification status
    if (!user.email_verified) {
      return res.status(403).json({ message: "Please verify your email before signing in." });
    }

    // Generate JWT access + refresh tokens
    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user);

    // Save refresh token hash in DB
    const hashedRefresh = hashToken(refreshToken);
    await db.query('UPDATE public.users SET refresh_token_hash = $1 WHERE id = $2', [hashedRefresh, user.id]);

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
    console.error("Login error:", err);
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
    const decoded = jwt.verify(refreshToken, secret);
    
    const userRes = await db.query(
      'SELECT id, email, full_name, refresh_token_hash, created_at FROM public.users WHERE id = $1',
      [decoded.sub]
    );

    if (userRes.rows.length === 0) {
      return res.status(401).json({ message: "User not found." });
    }

    const user = userRes.rows[0];

    // Verify refresh token hash matches stored database hash
    const currentHash = hashToken(refreshToken);
    if (user.refresh_token_hash !== currentHash) {
      return res.status(401).json({ message: "Invalid or expired refresh token." });
    }

    // Issue new access + refresh tokens
    const newAccessToken = generateAccessToken(user);
    const newRefreshToken = generateRefreshToken(user);

    const newHashedRefresh = hashToken(newRefreshToken);
    await db.query('UPDATE public.users SET refresh_token_hash = $1 WHERE id = $2', [newHashedRefresh, user.id]);

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
    console.error("Forgot password error:", err);
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
    console.error("Render reset password page error:", err);
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

    // Hash new password, clear the reset token, and revoke the refresh token
    // so any session an attacker may already hold dies with the old password
    // (complexity rules are enforced by resetPasswordSchema above).
    const newPasswordHash = await bcrypt.hash(validated.password, 10);
    await db.query(
      'UPDATE public.users SET password_hash = $1, reset_token_hash = NULL, reset_token_expires_at = NULL, refresh_token_hash = NULL WHERE id = $2',
      [newPasswordHash, user.id]
    );

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
    console.error("Reset password POST error:", err);
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
    console.error("Check status error:", err);
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
      await db.query('UPDATE public.users SET verification_token_hash = $1 WHERE id = $2', [hashToken(token), user.id]);

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
    console.error("Resend verification error:", err);
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
      'SELECT id, email, full_name, created_at FROM public.users WHERE google_id = $1',
      [googleId]
    );

    if (byGoogleId.rows.length > 0) {
      // Existing Google user — just log in
      user = byGoogleId.rows[0];
    } else {
      // 2) Look up by email
      const byEmail = await db.query(
        'SELECT id, email, full_name, avatar_url, created_at FROM public.users WHERE email = $1',
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

        // Resolve country from the request IP for analytics only; the IP itself is not stored.
        const geo = getCountryFromIp(req.ip);
        const countryCode = geo ? geo.countryCode : null;
        const countryName = geo ? geo.countryName : null;
        // TEMPORARY DIAGNOSTIC - remove after wrong-country investigation (see /api/_debug/ip-check in app.js)
        console.log('[geoip-debug][googleSignIn]', JSON.stringify({
          reqIp: req.ip, reqIps: req.ips,
          xForwardedFor: req.headers?.['x-forwarded-for'] || null,
          xRealIp: req.headers?.['x-real-ip'] || null,
          socketRemoteAddress: req.socket?.remoteAddress || null,
          geo,
        }));

        await db.query(
          `INSERT INTO public.users
             (id, full_name, email, password_hash, email_verified, google_id, provider, avatar_url, country_code, country_name)
           VALUES ($1, $2, $3, NULL, true, $4, 'google', $5, $6, $7)`,
          [userId, fullName, email, googleId, avatarUrl, countryCode, countryName]
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
          'SELECT id, email, full_name, created_at FROM public.users WHERE id = $1',
          [userId]
        );
        user = newUserRes.rows[0];
      }
    }

    // Generate JWT access + refresh tokens (same as email login)
    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user);

    const hashedRefresh = hashToken(refreshToken);
    await db.query(
      'UPDATE public.users SET refresh_token_hash = $1 WHERE id = $2',
      [hashedRefresh, user.id]
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
    console.error('Google sign-in error:', err);
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

    // Hash and update the new password, rotating the refresh token in the
    // same statement: every other logged-in device/session is revoked, while
    // the fresh token pair returned below keeps this session working.
    const newAccessToken = generateAccessToken(user);
    const newRefreshToken = generateRefreshToken(user);
    const newHash = await bcrypt.hash(newPassword, 10);
    await db.query(
      'UPDATE public.users SET password_hash = $1, refresh_token_hash = $2 WHERE id = $3',
      [newHash, hashToken(newRefreshToken), userId]
    );

    res.json({
      message: "Password changed successfully.",
      accessToken: newAccessToken,
      refreshToken: newRefreshToken
    });

  } catch (err) {
    console.error("Change password error:", err);
    res.status(500).json({ message: "An unexpected error occurred." });
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
};
