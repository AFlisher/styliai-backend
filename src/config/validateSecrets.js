/**
 * Boot-time validation of server-side signing secrets (SEC-17.1).
 *
 * The audit found ADMIN_JWT_SECRET set to a hand-composed passphrase. Admin
 * tokens are HS256, so the verification key IS the signing key: anyone holding
 * a single admin JWT can attack the secret entirely offline - no rate limit, no
 * log entry. Recovering it means forging admin tokens indefinitely, surviving
 * password changes and the 2h expiry, because the secret rather than the
 * session is compromised.
 *
 * Rotating the value fixes the instance; this module is what stops the class
 * from coming back. It deliberately checks only *objective* properties -
 * presence, a minimum length, and an exact-match placeholder list. It does not
 * estimate entropy and does not look for product names or dictionary words:
 * those are guesses about strength, they produce false positives on legitimate
 * random secrets, and a boot-time assertion that can misfire on a good value is
 * worse than one that checks less.
 *
 * A consequence worth stating plainly: a long hand-written passphrase PASSES
 * these checks. This module is a floor, not a judge of quality. Generating the
 * secret correctly is the actual control:
 *
 *     openssl rand -base64 48
 */

/**
 * Minimum accepted length, in bytes of the UTF-8 encoded value.
 *
 * 32 bytes is the floor. Note this measures the encoded string, not the raw
 * random material behind it: a base64 secret needs 44+ characters to carry 32
 * random bytes. The recommended `openssl rand -base64 48` yields 64 characters
 * and clears the floor comfortably either way.
 */
const MIN_ADMIN_JWT_SECRET_BYTES = 32;

/**
 * Values that are obviously stand-ins rather than real secrets - the kind that
 * arrives by copying an example file or a tutorial. Compared by exact match
 * after trimming and lower-casing, never as substrings, so a legitimate random
 * secret cannot collide with one of these by chance.
 */
const PLACEHOLDER_SECRETS = new Set([
  'test',
  'testing',
  'secret',
  'password',
  'admin',
  'default',
  'example',
  'placeholder',
  'todo',
  'changeme',
  'change-me',
  'change_me',
  'your-secret-here',
  'your_secret_here',
  'yoursecrethere',
  'none',
  'null',
  'undefined'
]);

/**
 * Pure check. Returns null when the secret is acceptable, otherwise a string
 * describing the problem.
 *
 * The returned message never contains the secret itself - only its length -
 * because this string is written to logs on the failure path.
 */
function checkAdminJwtSecret(env = process.env) {
  const raw = env.ADMIN_JWT_SECRET;

  if (raw === undefined || raw === null || raw.trim() === '') {
    return 'ADMIN_JWT_SECRET is not set (or is empty).';
  }

  const value = raw.trim();

  if (PLACEHOLDER_SECRETS.has(value.toLowerCase())) {
    return 'ADMIN_JWT_SECRET is a placeholder value, not a real secret.';
  }

  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes < MIN_ADMIN_JWT_SECRET_BYTES) {
    return (
      `ADMIN_JWT_SECRET is too short: ${bytes} bytes, minimum is ` +
      `${MIN_ADMIN_JWT_SECRET_BYTES}.`
    );
  }

  return null;
}

/**
 * Boot-time assertion.
 *
 * Fails closed in production - the process refuses to start rather than serve
 * admin authentication on a weak key. Outside production it warns instead, so a
 * throwaway local value doesn't block development, mirroring how
 * `buildSslConfig` treats DATABASE_CA_CERT.
 *
 * Returns true when the secret is acceptable, false when it was rejected but
 * the environment only warranted a warning.
 */
function validateAdminJwtSecret(env = process.env) {
  const problem = checkAdminJwtSecret(env);

  if (!problem) {
    return true;
  }

  const remedy = 'Generate one with: openssl rand -base64 48';

  if (env.NODE_ENV === 'production') {
    throw new Error(`[config] ${problem} ${remedy}`);
  }

  console.warn(`[config] WARNING: ${problem} ${remedy}`);
  return false;
}

module.exports = {
  checkAdminJwtSecret,
  validateAdminJwtSecret,
  MIN_ADMIN_JWT_SECRET_BYTES,
  PLACEHOLDER_SECRETS
};
