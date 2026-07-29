/**
 * SEC-0.2 configuration.
 *
 * Every knob here is read once at module load so the values are stable for the
 * process lifetime and testable as pure data. Nothing in this file makes a
 * policy decision — PLAY_INTEGRITY_ENFORCEMENT is parsed and exposed here, but
 * it is SEC-0.5 that will read it. It lives here because the flag is the
 * rollback mechanism for the whole workstream and belongs with the rest of the
 * configuration rather than buried in whichever module lands first.
 */

const ENFORCEMENT_MODES = Object.freeze(["off", "log", "enforce"]);

function positiveInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `[playIntegrityConfig] ${name}="${raw}" is not a positive number; using ${fallback}`
    );
    return fallback;
  }
  return Math.floor(parsed);
}

/**
 * off     - do not request or evaluate anything (the middleware no-ops).
 * log     - verify and annotate, never act. The launch posture, and Google's
 *           own advice: understand the verdict distribution of your real
 *           install base before you deny anyone.
 * enforce - SEC-0.5 acts on req.integrity. Nothing in SEC-0.2 behaves
 *           differently in this mode; it is here so the flag has one home.
 */
function parseEnforcement() {
  const raw = (process.env.PLAY_INTEGRITY_ENFORCEMENT || "log").trim().toLowerCase();
  if (!ENFORCEMENT_MODES.includes(raw)) {
    console.warn(
      `[playIntegrityConfig] PLAY_INTEGRITY_ENFORCEMENT="${raw}" is not one of ${ENFORCEMENT_MODES.join("/")}; using "log"`
    );
    return "log";
  }
  return raw;
}

const config = Object.freeze({
  enforcement: parseEnforcement(),

  /** Expected package name, checked against appIntegrity.packageName. */
  packageName: (process.env.PLAY_INTEGRITY_PACKAGE_NAME || "").trim(),

  /**
   * How old a token may be. Google returns requestDetails.timestampMillis
   * (when the token was minted on the device); anything older than this is
   * INTEGRITY_STALE. Generous enough to cover a slow upload on a bad
   * connection, tight enough that a captured token is not useful tomorrow.
   */
  maxAgeMs: positiveInt("PLAY_INTEGRITY_MAX_AGE_MS", 5 * 60 * 1000),

  /** Hard cap on the outbound Google decode call. */
  decodeTimeoutMs: positiveInt("PLAY_INTEGRITY_DECODE_TIMEOUT_MS", 2000),

  /**
   * How long a decoded verdict may be reused. This only has to cover SEC-0.1's
   * single 401 retry. Google warns that caching integrity verdicts increases
   * the risk of proxying — a good device's verdict authorising a later request
   * from somewhere else — so this is deliberately minutes, not hours.
   */
  verdictTtlMs: positiveInt("PLAY_INTEGRITY_VERDICT_TTL_MS", 10 * 60 * 1000),

  /**
   * How long the row survives after its verdict is dropped, purely so a token
   * presented again much later is recognisable as a replay rather than looking
   * like a fresh token.
   */
  ledgerTtlMs: positiveInt("PLAY_INTEGRITY_LEDGER_TTL_MS", 24 * 60 * 60 * 1000),

  /**
   * Decode attempts allowed per caller per window before we stop calling
   * Google for them. This is not a request limiter and never rejects anything
   * — it protects the shared 10,000/day account quota, which an attacker could
   * otherwise burn with junk tokens and deny to every real user.
   */
  decodeRateLimit: positiveInt("PLAY_INTEGRITY_DECODE_RATE_LIMIT", 30),
  decodeRateWindowMs: positiveInt("PLAY_INTEGRITY_DECODE_RATE_WINDOW_MS", 60 * 1000),

  /**
   * Bounded wait for the process that did NOT win the decode claim. Total wait
   * is pollAttempts * pollIntervalMs and must stay well inside the request's
   * own timeout; exceeding it yields INTEGRITY_DECODE_UNAVAILABLE rather than
   * hanging the caller.
   */
  pollAttempts: positiveInt("PLAY_INTEGRITY_POLL_ATTEMPTS", 4),
  pollIntervalMs: positiveInt("PLAY_INTEGRITY_POLL_INTERVAL_MS", 250),
});

/**
 * Whether verification can run at all. Absent configuration is not an error:
 * it means the feature is dark, every request is annotated
 * INTEGRITY_ABSENT/disabled, and SEC-0.5 decides what that means. That is what
 * lets this ship before the Play Console prerequisites exist.
 */
function isConfigured() {
  return config.enforcement !== "off" && config.packageName.length > 0;
}

module.exports = { config, isConfigured, ENFORCEMENT_MODES };
