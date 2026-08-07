const { policy: abusePolicy } = require("./abusePolicy");
const { config: integrityConfig, isConfigured: isIntegrityConfigured } = require("./playIntegrityConfig");

/**
 * System Health module — the "safe values only" environment summary.
 *
 * The safe/unsafe split is not invented here: SECURITY_OPERATIONS.md §2
 * already categorizes every env var this backend reads, and
 * configHardening.test.js enforces that every `process.env.X` the code reads
 * appears in that document. This module is simply the first place that acts
 * on that existing classification for an admin-facing read, rather than
 * re-deriving it.
 *
 * Two rules, applied without exception:
 *   1. A credential-shaped var (API key, secret, connection string, salt) is
 *      NEVER exposed as a value - only as `configured: true/false`, via the
 *      exact same "is this set and not a placeholder" check sendEmail.js and
 *      the provider configs already apply themselves.
 *   2. Tuning/feature-flag vars ARE exposed as values, but by reusing the
 *      already-parsed, already-validated config objects (abusePolicy.policy,
 *      playIntegrityConfig.config) rather than re-reading process.env here -
 *      one parser per setting, not two that could drift.
 */

function isConfiguredValue(value) {
  return Boolean(value && !String(value).trim().startsWith("YOUR_"));
}

function buildEnvSummary(env = process.env) {
  return {
    nodeEnv: env.NODE_ENV || null,
    imageProvider: env.IMAGE_PROVIDER || null,
    logLevel: env.LOG_LEVEL || null,

    abuseDetection: {
      sweepEnabled: abusePolicy.sweepEnabled,
      sweepIntervalMs: abusePolicy.sweepIntervalMs,
      autoSuspendEnabled: abusePolicy.enforcement.autoSuspendEnabled,
    },

    playIntegrity: {
      enforcement: integrityConfig.enforcement,
      sweepIntervalMs: integrityConfig.sweepIntervalMs,
      configured: isIntegrityConfigured(),
    },

    // Booleans only - never the key itself. Mirrors the exact "set and not a
    // YOUR_* placeholder" predicate sendEmail.js already applies to
    // RESEND_API_KEY.
    servicesConfigured: {
      email: isConfiguredValue(env.RESEND_API_KEY),
      stabilityAI: isConfiguredValue(env.STABILITY_API_KEY),
      gemini: isConfiguredValue(env.GEMINI_API_KEY),
      fal: isConfiguredValue(env.FAL_API_KEY),
      turnstile: isConfiguredValue(env.TURNSTILE_SECRET_KEY),
    },
  };
}

module.exports = { buildEnvSummary };
