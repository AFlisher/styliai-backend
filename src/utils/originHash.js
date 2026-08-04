const crypto = require("crypto");

/**
 * SEC-18.3 - a correlation key that is not personal data.
 *
 * THE PROBLEM
 * -----------
 * Both registration paths resolved a country from the request IP and then
 * discarded the IP, with a code comment stating so explicitly. That is good
 * data minimisation and the audit agrees it is defensible - but it records the
 * cost rather than disputing it: IP is the primary correlation signal for
 * multi-accounting, and without it (plus no device binding at the time) two
 * accounts created one second apart from the same device on the same
 * connection are, in the stored data, indistinguishable from two unrelated
 * users in the same country. Country is far too coarse to correlate
 * individuals: "many registrations from country X this hour" is also exactly
 * what a successful marketing campaign looks like.
 *
 * The finding is therefore not that farming is happening - Section 18's
 * economics analysis argues it mostly is not - but that the data model
 * forecloses the INVESTIGATION, not just the prevention.
 *
 * THE APPROACH, which is the audit's own recommendation
 * ----------------------------------------------------
 * Store `HMAC(server_salt, ip)` rather than the IP. This supports the one
 * question detection needs - "how many accounts share this origin?" - while
 * being irreversible without the salt.
 *
 * WHY HMAC AND NOT A PLAIN HASH. The IPv4 space is 2^32; a plain SHA-256 of an
 * IP is trivially reversed by enumerating all four billion of them in minutes.
 * A keyed hash makes that impossible without the key, which is what turns this
 * from "the IP with extra steps" into a genuine one-way correlation key.
 *
 * WHAT THIS IS NOT
 * ----------------
 * It is NOT an authorization input and must never become one. Carrier-grade
 * NAT, campus wifi, corporate egress and ordinary households all put many
 * unrelated people behind one origin - so a shared origin hash is a hint for a
 * human reviewer, never evidence on its own. Every detector that uses it
 * treats a match as a signal to raise for review, not as grounds to act.
 *
 * RETENTION AND ROTATION
 * ----------------------
 * Rotating `IP_HASH_SALT` invalidates every stored hash at once, which IS the
 * retention control: correlation ability decays to zero on rotation with no
 * data migration. There is deliberately no way to re-derive old hashes.
 */

// Cached after first read so a per-request HMAC does not re-read the
// environment. Deliberately module-scoped rather than computed at import time
// so tests can reset it.
let cachedSalt;
let warnedMissing = false;

/**
 * Resolves the HMAC key.
 *
 * A MISSING SALT DISABLES CORRELATION RATHER THAN INVENTING ONE. Two rejected
 * alternatives, both worse:
 *   - Generating a random salt at boot would silently produce a key that
 *     changes on every deploy and every instance, so correlation would appear
 *     to work while quietly grouping nothing. A control that looks like it is
 *     running and is not is worse than an absent one.
 *   - Falling back to a constant would make the hash a plain hash of the IP,
 *     i.e. reversible by enumeration - it would turn a privacy-preserving key
 *     back into stored PII, which is the exact thing this exists to avoid.
 *
 * So: no salt, no hash. Detection degrades to country-level (what it was
 * before Phase 8) and says so in the logs, once.
 */
function getSalt(env = process.env) {
  if (cachedSalt !== undefined) return cachedSalt;

  const raw = env.IP_HASH_SALT;
  if (typeof raw === "string" && raw.trim().length >= 16) {
    cachedSalt = raw.trim();
    return cachedSalt;
  }

  if (!warnedMissing) {
    warnedMissing = true;
    console.warn(
      JSON.stringify({
        event: "origin_hash_disabled",
        reason:
          raw === undefined || raw === ""
            ? "IP_HASH_SALT_not_set"
            : "IP_HASH_SALT_too_short_min_16_chars",
        consequence:
          "SEC-18.3 origin correlation is inactive; multi-account detection degrades to country granularity",
      })
    );
  }

  cachedSalt = null;
  return cachedSalt;
}

/**
 * Normalises an address before hashing, so the same client hashes consistently.
 *
 * Without this, `::ffff:1.2.3.4` (an IPv4-mapped IPv6 address, which is what
 * Node reports for an IPv4 client on a dual-stack socket) and `1.2.3.4` would
 * produce different hashes for the same machine - correlation would silently
 * fail for exactly the clients it most needs to group.
 */
function normalizeIp(ip) {
  if (typeof ip !== "string") return null;
  let value = ip.trim().toLowerCase();
  if (!value) return null;

  // IPv4-mapped IPv6.
  if (value.startsWith("::ffff:")) value = value.slice(7);

  // Strip a port if one came along (some proxy configurations append one).
  // Only for IPv4 - a bare IPv6 address legitimately contains colons.
  const v4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(value);
  if (v4WithPort) value = v4WithPort[1];

  return value || null;
}

/**
 * Returns the origin hash for a request, or null when correlation is
 * unavailable (no salt configured, or no resolvable address).
 *
 * Callers MUST treat null as "unknown origin" and never as a group key -
 * grouping every unresolvable request together would manufacture a fake
 * cluster of unrelated accounts, which is a false positive generator aimed
 * squarely at the users behind the most unusual network setups.
 */
function originHashFor(req, env = process.env) {
  const salt = getSalt(env);
  if (!salt) return null;

  // req.ip is Express's resolved client address, correct here because
  // `trust proxy` is set to the verified hop count (see app.js). Using
  // socket.remoteAddress instead would hash Railway's load balancer and group
  // every user in the deployment under one origin.
  const ip = normalizeIp(req && req.ip);
  if (!ip) return null;

  return hashIp(ip, env);
}

/**
 * Exposed separately so tests and backfills can hash a known address.
 *
 * Truncated to 32 hex chars (128 bits). Full width buys nothing here - this is
 * a grouping key, not a MAC being verified - and a shorter value keeps the
 * index and the JSONB evidence blobs small. 128 bits is far beyond collision
 * relevance for this population size.
 */
function hashIp(ip, env = process.env) {
  const salt = getSalt(env);
  if (!salt) return null;
  const normalized = normalizeIp(ip);
  if (!normalized) return null;

  return crypto
    .createHmac("sha256", salt)
    .update(normalized, "utf8")
    .digest("hex")
    .slice(0, 32);
}

/** Test seam: clears the cached salt so a test can vary the environment. */
function resetSaltCache() {
  cachedSalt = undefined;
  warnedMissing = false;
}

module.exports = {
  originHashFor,
  hashIp,
  normalizeIp,
  resetSaltCache,
  isEnabled: (env = process.env) => getSalt(env) !== null,
};
