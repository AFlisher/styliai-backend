const crypto = require("crypto");

/**
 * SEC-15.2: encryption at rest for admin TOTP secrets.
 *
 * A TOTP secret is symmetric: it is not a hash of anything, and anyone holding
 * it can generate valid codes indefinitely. Stored in plaintext it would make
 * read access to the `admins` table equivalent to a permanent MFA bypass, which
 * would leave the second factor adding nothing against exactly the database
 * compromise scenario people add MFA to survive. So it is encrypted under a key
 * that lives only in the environment, never in the database.
 *
 * AES-256-GCM, random 12-byte IV per encryption, authentication tag stored
 * alongside. GCM rather than CBC because the ciphertext must be tamper-evident:
 * an attacker with write access to the column but not the key must not be able
 * to swap in a secret of their choosing without detection.
 *
 * ---------------------------------------------------------------------------
 * OPERATIONAL REQUIREMENT - READ BEFORE MANAGING THIS KEY
 * ---------------------------------------------------------------------------
 * MFA_ENCRYPTION_KEY must be 32 random bytes, base64-encoded:
 *
 *     openssl rand -base64 32
 *
 * Set it in Railway (and in local .env for development). Then:
 *
 *  1. LOSING THE KEY LOCKS OUT EVERY ENROLLED ADMIN. The stored secrets become
 *     undecryptable. Because this codebase has no admin password-reset flow,
 *     recovery would then be: use a recovery code, or edit the database
 *     directly to clear mfa_enabled. Keep the key backed up somewhere that is
 *     not this database and not this repository.
 *
 *  2. ROTATING THE KEY IS NOT A CONFIG CHANGE. Every stored mfa_secret must be
 *     decrypted with the old key and re-encrypted with the new one in the same
 *     operation. There is deliberately no automatic re-encryption here: a
 *     silent fallback that re-enrolled or cleared secrets on a key mismatch
 *     would turn a typo in an environment variable into a fleet-wide MFA
 *     bypass. A mismatch fails loudly instead.
 *
 *  3. IT IS A DIFFERENT SECRET FROM ADMIN_JWT_SECRET, on purpose. Reusing one
 *     key for both would mean a single leak both forges tokens and decrypts
 *     second factors.
 *
 * Boot-time presence/length validation lives in src/config/validateSecrets.js,
 * alongside the ADMIN_JWT_SECRET check, so a production instance refuses to
 * start with a missing or malformed key rather than failing at first login.
 */

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

// Serialized as `v1.<iv>.<tag>.<ciphertext>`, all base64. The version prefix is
// what makes a future algorithm change possible without guessing at the format
// of rows already in the table.
const FORMAT_VERSION = "v1";

/**
 * Decodes and validates MFA_ENCRYPTION_KEY.
 *
 * Pure with respect to `env` so tests can exercise it without touching the
 * real process environment, matching checkAdminJwtSecret / buildSslConfig.
 *
 * @throws {Error} when the key is missing or not exactly 32 bytes. Never
 *   includes the key material in the message - these messages reach logs.
 */
function loadKey(env = process.env) {
  const raw = env.MFA_ENCRYPTION_KEY;

  if (raw === undefined || raw === null || String(raw).trim() === "") {
    throw new Error(
      "MFA_ENCRYPTION_KEY is not set. Generate one with: openssl rand -base64 32"
    );
  }

  let key;
  try {
    key = Buffer.from(String(raw).trim(), "base64");
  } catch (err) {
    throw new Error("MFA_ENCRYPTION_KEY is not valid base64.");
  }

  if (key.length !== KEY_BYTES) {
    throw new Error(
      `MFA_ENCRYPTION_KEY must decode to exactly ${KEY_BYTES} bytes, got ${key.length}. ` +
        "Generate one with: openssl rand -base64 32"
    );
  }

  return key;
}

/**
 * @param {string} plaintext - the base32 TOTP secret.
 * @returns {string} `v1.<iv>.<tag>.<ciphertext>`
 */
function encryptSecret(plaintext, env = process.env) {
  if (typeof plaintext !== "string" || plaintext === "") {
    throw new Error("encryptSecret requires a non-empty string.");
  }

  const key = loadKey(env);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    FORMAT_VERSION,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(".");
}

/**
 * Inverse of encryptSecret.
 *
 * Throws on any tampering, truncation, wrong key or malformed input rather than
 * returning a partial or empty result: the caller uses this value to decide
 * whether a login succeeds, so "couldn't decrypt" must never be able to look
 * like "no second factor configured".
 */
function decryptSecret(serialized, env = process.env) {
  if (typeof serialized !== "string" || serialized === "") {
    throw new Error("decryptSecret requires a non-empty string.");
  }

  const parts = serialized.split(".");
  if (parts.length !== 4 || parts[0] !== FORMAT_VERSION) {
    throw new Error("Stored MFA secret is not in the expected v1 format.");
  }

  const key = loadKey(env);
  const iv = Buffer.from(parts[1], "base64");
  const tag = Buffer.from(parts[2], "base64");
  const ciphertext = Buffer.from(parts[3], "base64");

  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error("Stored MFA secret has a malformed IV or authentication tag.");
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  // decipher.final() is what raises on a bad tag - i.e. wrong key or tampered
  // ciphertext. Deliberately not caught here.
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

module.exports = {
  loadKey,
  encryptSecret,
  decryptSecret,
  KEY_BYTES,
  FORMAT_VERSION,
};
