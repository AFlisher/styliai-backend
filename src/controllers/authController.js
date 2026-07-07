const { z } = require('zod');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const db = require('../config/db');
const sendEmail = require('../utils/sendEmail');
const { renderVerificationPage, renderResetPasswordPage } = require('../utils/htmlTemplates');

const GOOGLE_CLIENT_ID = '393948547098-qji62u4235f83e72eio9vi1fp4a9lmu9.apps.googleusercontent.com';
const googleOAuth2Client = new OAuth2Client(GOOGLE_CLIENT_ID);

// Helper to hash tokens with SHA-256 for secure database storage
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Validation schemas using Zod
const registerSchema = z.object({
  email: z.string().email("Invalid email format"),
  password: z.string().min(6, "Password must be at least 6 characters"),
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
  password: z.string().min(8, "Password must be at least 8 characters")
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

    // Get a client from the pool for the transaction
    client = await db.pool.connect();
    
    // BEGIN transaction
    await client.query('BEGIN');

    // Save user inside PostgreSQL (public.users)
    await client.query(`
      INSERT INTO public.users (id, full_name, email, password_hash, email_verified, verification_token, provider)
      VALUES ($1, $2, $3, $4, false, $5, 'email')
    `, [userId, validated.fullName, validated.email.toLowerCase(), passwordHash, verificationToken]);

    // Save corresponding profile inside public.profiles
    await client.query(`
      INSERT INTO public.profiles (id, full_name, email, provider, credits)
      VALUES ($1, $2, $3, 'email', 3)
    `, [userId, validated.fullName, validated.email.toLowerCase()]);

    // Send verification email using Resend
    const backendUrl = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 3000}`;
    const verificationLink = `${backendUrl}/api/auth/verify?token=${verificationToken}`;
    
    const emailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #05050A; color: #FFFFFF; border-radius: 12px; border: 1px solid #1E1E2F;">
        <h2 style="color: #A855F7; text-align: center;">Welcome to StyliAI!</h2>
        <p>Hello ${validated.fullName},</p>
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
      return res.status(400).json({ message: err.errors[0].message });
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
      'SELECT id, email_verified FROM public.users WHERE verification_token = $1',
      [token]
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
      'UPDATE public.users SET email_verified = true, verification_token = NULL WHERE id = $1',
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
      return res.status(400).json({ message: err.errors[0].message });
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
    
    // Check if user exists
    if (userRes.rows.length === 0) {
      return res.status(404).json({ message: "No account found with this email." });
    }

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
        <p>Hello ${user.full_name},</p>
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

    res.json({ message: "Reset email sent." });

  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ message: err.errors[0].message });
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

    // Password requirements validation checks (uppercase, lowercase, digit, special character)
    const passwordVal = validated.password;
    const hasUpper = /[A-Z]/.test(passwordVal);
    const hasLower = /[a-z]/.test(passwordVal);
    const hasDigit = /[0-9]/.test(passwordVal);
    const hasSpecial = /[!@#\$&*~]/.test(passwordVal);

    if (!hasUpper || !hasLower || !hasDigit || !hasSpecial) {
      return res.status(400).send(renderResetPasswordPage({
        token: validated.token,
        error: "Password does not meet requirements. It must contain at least 1 uppercase letter, 1 lowercase letter, 1 digit, and 1 special character (!@#$&*~)."
      }));
    }

    // Hash new password and clear the reset token
    const newPasswordHash = await bcrypt.hash(passwordVal, 10);
    await db.query(
      'UPDATE public.users SET password_hash = $1, reset_token_hash = NULL, reset_token_expires_at = NULL WHERE id = $2',
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
        error: err.errors[0].message
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

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "User not found." });
    }

    res.json({ verified: result.rows[0].email_verified });
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
      'SELECT id, full_name, email_verified, verification_token FROM public.users WHERE email = $1',
      [email.toLowerCase()]
    );

    if (userRes.rows.length === 0) {
      return res.status(404).json({ message: "User not found." });
    }

    const user = userRes.rows[0];
    if (user.email_verified) {
      return res.status(400).json({ message: "Email is already verified." });
    }

    const token = user.verification_token || uuidv4();
    if (!user.verification_token) {
      await db.query('UPDATE public.users SET verification_token = $1 WHERE id = $2', [token, user.id]);
    }

    const backendUrl = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 3000}`;
    const verificationLink = `${backendUrl}/api/auth/verify?token=${token}`;

    const emailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #05050A; color: #FFFFFF; border-radius: 12px; border: 1px solid #1E1E2F;">
        <h2 style="color: #A855F7; text-align: center;">Verify Your Email</h2>
        <p>Hello ${user.full_name},</p>
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

    res.json({ message: "Verification link resent successfully." });

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
        await db.query(
          `INSERT INTO public.users
             (id, full_name, email, password_hash, email_verified, google_id, provider, avatar_url)
           VALUES ($1, $2, $3, NULL, true, $4, 'google', $5)`,
          [userId, fullName, email, googleId, avatarUrl]
        );

        // Create matching profile row
        await db.query(
          `INSERT INTO public.profiles (id, full_name, email, provider, avatar_url, credits)
           VALUES ($1, $2, $3, 'google', $4, 3)`,
          [userId, fullName, email, avatarUrl]
        );

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

    if (newPassword.length < 8) {
      return res.status(400).json({ message: "New password must be at least 8 characters." });
    }

    const userId = req.user.id;
    const userRes = await db.query(
      'SELECT id, password_hash, provider FROM public.users WHERE id = $1',
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

    // Hash and update the new password
    const newHash = await bcrypt.hash(newPassword, 10);
    await db.query(
      'UPDATE public.users SET password_hash = $1 WHERE id = $2',
      [newHash, userId]
    );

    res.json({ message: "Password changed successfully." });

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
