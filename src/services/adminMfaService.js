const bcrypt = require("bcrypt");
const crypto = require("crypto");
const { authenticator } = require("otplib");
const db = require("../config/db");
const { encryptSecret, decryptSecret } = require("../utils/mfaCrypto");

/**
 * SEC-15.2: TOTP second factor for admin login.
 *
 * Verification lives here rather than in adminController so the controller
 * keeps its single responsibility (the login sequence) and so the replay and
 * lockout behaviour is testable without driving an HTTP request.
 */

// RFC 6238 defaults, stated explicitly rather than inherited from otplib's
// configuration so a dependency upgrade can't silently widen them.
//
// The window is the security-critical number: each extra step multiplies the
// codes valid at any instant. `window: 1` accepts the previous, current and
// next step - three codes, ~90s of tolerance - which covers ordinary phone
// clock drift and a slow typist. Anything wider trades brute-force resistance
// for convenience the operators here don't need.
const TOTP_OPTIONS = { step: 30, digits: 6, window: 1 };

authenticator.options = TOTP_OPTIONS;

const RECOVERY_CODE_COUNT = 10;
// 16 characters drawn from a 32-symbol alphabet = 80 bits each, one CSPRNG
// byte per character. Displayed in two groups of 8.
const RECOVERY_CODE_LENGTH = 16;
// Same cost as admin passwords (createAdmin.js): these are password-equivalent
// bearer credentials and get password-equivalent treatment.
const RECOVERY_CODE_BCRYPT_COST = 12;

/** Current TOTP time step - the replay-protection counter. */
function currentTimestep(now = Date.now()) {
  return Math.floor(now / 1000 / TOTP_OPTIONS.step);
}

/**
 * Which time step a given code belongs to, or null if it matches none in the
 * accepted window.
 *
 * otplib's `check` answers "is this valid" but not "as of when", and the
 * timestep is exactly what replay protection needs to record. So the window is
 * walked explicitly here.
 */
function matchTimestep(code, secret, now = Date.now()) {
  const current = currentTimestep(now);
  const candidate = Buffer.from(String(code), "utf8");

  for (let offset = -TOTP_OPTIONS.window; offset <= TOTP_OPTIONS.window; offset++) {
    const step = current + offset;

    // `authenticator.generate(secret, t)` SILENTLY IGNORES t and returns the
    // code for the current time - generate() takes no time parameter. Passing
    // one made every offset in this loop compare against the same code, which
    // is both a wrong recorded timestep and a window that isn't the stated
    // +/-1. clone({ epoch }) is the supported way to pin the instant.
    const expected = authenticator
      .clone({ epoch: step * TOTP_OPTIONS.step * 1000 })
      .generate(secret);

    // Length-checked before the constant-time compare: timingSafeEqual throws
    // on a length mismatch, and an attacker controls the submitted length.
    const truth = Buffer.from(expected, "utf8");
    if (candidate.length === truth.length && crypto.timingSafeEqual(candidate, truth)) {
      return step;
    }
  }

  return null;
}

/**
 * Verifies a submitted TOTP code against an admin row and, on success, burns
 * the time step so the same code cannot be presented twice.
 *
 * @param {Object} admin - row carrying `id`, `mfa_secret`, `mfa_last_timestep`.
 * @param {string} code
 * @returns {Promise<boolean>}
 */
async function verifyTotp(admin, code, now = Date.now()) {
  if (!admin || !admin.mfa_secret) {
    return false;
  }
  if (typeof code !== "string" || !/^\d{6}$/.test(code.trim())) {
    return false;
  }

  // A decryption failure means a wrong/rotated MFA_ENCRYPTION_KEY or a tampered
  // column. It must surface as a failed login, never as a bypass - so it is
  // caught here and answered `false` rather than allowed to look like "this
  // admin has no second factor".
  let secret;
  try {
    secret = decryptSecret(admin.mfa_secret);
  } catch (err) {
    console.error(`[mfa] could not decrypt stored secret for admin ${admin.id}:`, err.message);
    return false;
  }

  const step = matchTimestep(code.trim(), secret, now);
  if (step === null) {
    return false;
  }

  // Replay protection: a TOTP code is valid for its whole step plus the skew
  // window, so without this a code observed in transit is reusable for ~90s.
  // The comparison is `<=` so re-presenting the same code, or an older one from
  // still inside the window, is refused.
  const lastStep = admin.mfa_last_timestep === null || admin.mfa_last_timestep === undefined
    ? null
    : Number(admin.mfa_last_timestep);
  if (lastStep !== null && step <= lastStep) {
    return false;
  }

  // Conditional UPDATE rather than a bare assignment: two concurrent logins
  // presenting the same code would otherwise both read the old value and both
  // succeed. Whichever commits first advances the step; the second matches no
  // row and is rejected below.
  const res = await db.query(
    `UPDATE admins
        SET mfa_last_timestep = $1
      WHERE id = $2
        AND (mfa_last_timestep IS NULL OR mfa_last_timestep < $1)`,
    [step, admin.id]
  );

  return res.rowCount === 1;
}

/**
 * Verifies a recovery code against the admin's unused codes and consumes it.
 *
 * Codes are bcrypt-hashed, so there is no way to look one up by value - every
 * unused code is compared. That is at most RECOVERY_CODE_COUNT bcrypt
 * operations, only ever reached when a code-shaped string is submitted.
 *
 * @returns {Promise<boolean>}
 */
async function verifyRecoveryCode(admin, submitted) {
  if (!admin || typeof submitted !== "string" || submitted.trim() === "") {
    return false;
  }

  const normalized = normalizeRecoveryCode(submitted);
  if (!/^[A-Z2-7]{16}$/.test(normalized)) {
    return false;
  }

  const res = await db.query(
    `SELECT id, code_hash FROM admin_mfa_recovery_codes
      WHERE admin_id = $1 AND used_at IS NULL`,
    [admin.id]
  );

  for (const row of res.rows) {
    // eslint-disable-next-line no-await-in-loop
    if (await bcrypt.compare(normalized, row.code_hash)) {
      // Conditional on used_at so two concurrent uses of the same code cannot
      // both succeed - same reasoning as the timestep UPDATE above.
      // eslint-disable-next-line no-await-in-loop
      const consumed = await db.query(
        `UPDATE admin_mfa_recovery_codes
            SET used_at = now()
          WHERE id = $1 AND used_at IS NULL`,
        [row.id]
      );
      return consumed.rowCount === 1;
    }
  }

  return false;
}

/** Accepts the code as displayed (grouped, lower case) or as stored. */
function normalizeRecoveryCode(value) {
  return String(value).toUpperCase().replace(/[^A-Z2-7]/g, "");
}

/** Base32 alphabet, so recovery codes read like the TOTP secret and avoid 0/1/8. */
const RECOVERY_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function generateRecoveryCode() {
  // One byte per character. 256 is an exact multiple of the 32-symbol alphabet,
  // so `byte % 32` is uniform - no modulo bias, and no rejection loop needed.
  // Deriving two characters from one byte (as a naive 5-bit split would) makes
  // them correlated and costs entropy; each character gets its own byte.
  const bytes = crypto.randomBytes(RECOVERY_CODE_LENGTH);
  let out = "";
  for (const byte of bytes) {
    out += RECOVERY_ALPHABET[byte % 32];
  }
  return out;
}

/**
 * Issues a fresh set of recovery codes, replacing any that exist.
 *
 * Returns the plaintext codes - the ONLY time they are ever available. Only
 * their bcrypt hashes are stored, so a lost set can be reissued but never
 * recovered.
 */
async function issueRecoveryCodes(adminId) {
  const codes = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    codes.push(generateRecoveryCode());
  }

  const hashes = [];
  for (const code of codes) {
    // eslint-disable-next-line no-await-in-loop
    hashes.push(await bcrypt.hash(code, RECOVERY_CODE_BCRYPT_COST));
  }

  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM admin_mfa_recovery_codes WHERE admin_id = $1`, [adminId]);
    for (const hash of hashes) {
      // eslint-disable-next-line no-await-in-loop
      await client.query(
        `INSERT INTO admin_mfa_recovery_codes (admin_id, code_hash) VALUES ($1, $2)`,
        [adminId, hash]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return codes;
}

/** Generates a new base32 secret and its otpauth:// enrollment URI. */
function generateEnrollment(adminEmail, issuer = "StyliAI Admin") {
  const secret = authenticator.generateSecret();
  return {
    secret,
    otpauthUrl: authenticator.keyuri(adminEmail, issuer, secret),
  };
}

/**
 * Stores the encrypted secret and switches enforcement on.
 *
 * Called only after a confirming code has been verified against the candidate
 * secret, so an admin can never end up enrolled with a secret their
 * authenticator never received - which, with no admin password-reset flow in
 * this codebase, would mean recovery codes or direct DB access.
 */
async function enableMfa(adminId, secret) {
  await db.query(
    `UPDATE admins
        SET mfa_secret = $1, mfa_enabled = true, mfa_enrolled_at = now(),
            mfa_last_timestep = NULL
      WHERE id = $2`,
    [encryptSecret(secret), adminId]
  );
}

module.exports = {
  verifyTotp,
  verifyRecoveryCode,
  issueRecoveryCodes,
  generateEnrollment,
  enableMfa,
  generateRecoveryCode,
  normalizeRecoveryCode,
  currentTimestep,
  matchTimestep,
  TOTP_OPTIONS,
  RECOVERY_CODE_COUNT,
};
