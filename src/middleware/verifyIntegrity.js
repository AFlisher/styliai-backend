const crypto = require("crypto");
const { config, isConfigured } = require("../config/playIntegrityConfig");
const integrityVerdictModel = require("../models/integrityVerdictModel");
const playIntegrityService = require("../services/playIntegrityService");
const integrityLedgerSweeper = require("../services/integrityLedgerSweeper");

/**
 * SEC-0.2 — verify a Play Integrity token and annotate the request.
 *
 * ==========================================================================
 * THIS MIDDLEWARE NEVER ENFORCES ANYTHING.
 * ==========================================================================
 *
 * It sets req.integrity and calls next(). It does not deny, it does not throw,
 * it does not branch on the verdict's contents, and it does not know what any
 * verdict is worth. Every policy decision - what PLAY_RECOGNIZED buys you,
 * whether a missing token is fatal, what to do during a Google outage - belongs
 * to SEC-0.5, which reads req.integrity and acts.
 *
 * The separation is not tidiness. Enforcement fused into verification would
 * mean no log-only mode, and no log-only mode means switching this on for real
 * users blind. Google's own guidance is to run without enforcement first and
 * look at what your actual install base returns.
 *
 * What req.integrity contains is backend-derived only: a taxonomy code we
 * computed, and the payload Google returned. Nothing the client asserted about
 * itself ever appears here - the client sends one opaque string and no claims.
 */

/**
 * The complete taxonomy. SEC-0.5 branches on these, so the split that matters
 * is the last one: DECODE_UNAVAILABLE is *our* failure (or Google's), every
 * other non-OK code is attributable to whoever sent the token. Collapsing them
 * would force SEC-0.5 to choose between failing open on attacks and failing
 * closed during an outage.
 */
const IntegrityStatus = Object.freeze({
  OK: "INTEGRITY_OK",
  ABSENT: "INTEGRITY_ABSENT",
  MALFORMED: "INTEGRITY_MALFORMED",
  STALE: "INTEGRITY_STALE",
  REQUEST_MISMATCH: "INTEGRITY_REQUEST_MISMATCH",
  PACKAGE_MISMATCH: "INTEGRITY_PACKAGE_MISMATCH",
  REPLAYED: "INTEGRITY_REPLAYED",
  DECODE_FAILED: "INTEGRITY_DECODE_FAILED",
  DECODE_UNAVAILABLE: "INTEGRITY_DECODE_UNAVAILABLE",
});

const HEADER = "x-integrity-token";

// A Play Integrity token is a long base64url-ish blob. This is a cheap shape
// check to avoid spending a Google decode (and a unit of the shared
// 10,000/day account quota) on something that cannot possibly be one.
const MIN_TOKEN_LENGTH = 40;
const MAX_TOKEN_LENGTH = 16 * 1024;

/**
 * In-process collapse of concurrent callers presenting the same token.
 *
 * The promise is inserted BEFORE the first await, so a second caller arriving
 * during the decode joins the in-flight work instead of racing to the database.
 * This is an optimisation only - integrity_verdicts is the authoritative
 * decrypt-once boundary, and has to be, because this map is per-process and
 * this service may run more than one.
 */
const inFlight = new Map();

/**
 * Decode-attempt budget per caller. Not a request limiter: it never rejects
 * anything. It stops one caller burning the shared daily Google quota with
 * junk tokens, which would deny verification to every other user - a cheap
 * availability attack if the only limit were per-request.
 */
const decodeBudget = new Map();

function consumeDecodeBudget(key) {
  const now = Date.now();
  const entry = decodeBudget.get(key);
  if (!entry || now >= entry.resetAt) {
    decodeBudget.set(key, { count: 1, resetAt: now + config.decodeRateWindowMs });
    return true;
  }
  if (entry.count >= config.decodeRateLimit) {
    return false;
  }
  entry.count += 1;
  return true;
}

/** Bounded, so decodeBudget cannot grow without limit under a distributed flood. */
function pruneDecodeBudget() {
  if (decodeBudget.size < 10000) return;
  const now = Date.now();
  for (const [key, entry] of decodeBudget) {
    if (now >= entry.resetAt) decodeBudget.delete(key);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256Base64Url(input) {
  return crypto.createHash("sha256").update(input, "utf8").digest("base64url");
}

/**
 * Rebuilds the exact string SEC-0.1's client hashed, from what the server
 * actually received.
 *
 * This is a contract, not an implementation detail: if the two sides disagree
 * by one byte, every request reports INTEGRITY_REQUEST_MISMATCH and the whole
 * control silently inverts into a denial machine. The client-side definitions
 * live in prompt_app lib/services/{api_service,wallet_service,auth_service}.dart.
 *
 * /api/ai/generate uses the RAW body bytes rather than a re-serialisation of
 * req.body: JSON.stringify would not reproduce the client's key order or
 * spacing, so it would mismatch on every request.
 */
function canonicalRequestFor(req) {
  const path = req.baseUrl + (req.route && req.route.path === "/" ? "" : req.path || "");

  if (path.startsWith("/api/generate")) {
    const parts = ["POST /api/generate", String(req.body && req.body.styleId ? req.body.styleId : "")];
    const fieldValues = req.body && req.body.fieldValues;
    if (typeof fieldValues === "string" && fieldValues.length > 0) {
      parts.push(fieldValues);
    }
    parts.push(`files:${Array.isArray(req.files) ? req.files.length : 0}`);
    return parts.join("\n");
  }

  if (path.startsWith("/api/ai")) {
    const raw = req.rawBody ? req.rawBody.toString("utf8") : "";
    return `POST /api/ai/generate\n${raw}`;
  }

  if (path.startsWith("/api/wallet")) {
    return "POST /api/wallet/reward";
  }

  if (path.startsWith("/api/auth")) {
    return `POST /api/auth/login\n${(req.body && req.body.email) || ""}`;
  }

  return null;
}

/**
 * Structured, and never carrying the token. SEC-16.1 established that this
 * codebase has leaked bearer material into logs once already; a token digest
 * prefix is enough to correlate two sightings without being usable if the log
 * escapes. Verdict *labels* are logged, raw payloads are not.
 */
function logIntegrity(req, annotation) {
  const verdict = annotation.verdict || {};
  console.log(
    JSON.stringify({
      event: "play_integrity",
      status: annotation.status,
      detail: annotation.detail || null,
      endpoint: annotation.endpoint,
      userId: (req.user && req.user.id) || null,
      tokenDigest: annotation.tokenDigest || null,
      cached: Boolean(annotation.cached),
      appRecognitionVerdict:
        (verdict.appIntegrity && verdict.appIntegrity.appRecognitionVerdict) || null,
      deviceRecognitionVerdict:
        (verdict.deviceIntegrity && verdict.deviceIntegrity.deviceRecognitionVerdict) || null,
      appLicensingVerdict:
        (verdict.accountDetails && verdict.accountDetails.appLicensingVerdict) || null,
      enforcement: config.enforcement,
    })
  );
}

/**
 * Validates a decoded payload against what the server itself computed.
 *
 * Note which package name is checked: appIntegrity.packageName, NOT
 * requestDetails.requestPackageName. Google annotates the latter with "this
 * field might be spoofed in the middle of the request" - validating it would
 * look like a control and be none.
 */
function validateVerdict(verdict, { expectedRequestHash }) {
  const requestDetails = verdict.requestDetails || {};
  const appIntegrity = verdict.appIntegrity || {};

  if (config.packageName && appIntegrity.packageName !== config.packageName) {
    // An UNEVALUATED app verdict legitimately omits packageName. That is not a
    // package mismatch, it is an unevaluated token - and it is also the
    // signature of a token decoded twice, so it must not be reported as an
    // attacker swapping packages.
    if (appIntegrity.appRecognitionVerdict === "UNEVALUATED" || !appIntegrity.packageName) {
      return { status: IntegrityStatus.REPLAYED, detail: "cleared_verdict" };
    }
    return { status: IntegrityStatus.PACKAGE_MISMATCH, detail: "package_name" };
  }

  if (requestDetails.requestHash !== expectedRequestHash) {
    return { status: IntegrityStatus.REQUEST_MISMATCH, detail: "request_hash" };
  }

  const timestampMillis = Number(requestDetails.timestampMillis);
  if (!Number.isFinite(timestampMillis)) {
    return { status: IntegrityStatus.MALFORMED, detail: "timestamp_missing" };
  }
  if (Date.now() - timestampMillis > config.maxAgeMs) {
    return { status: IntegrityStatus.STALE, detail: "outside_max_age" };
  }

  return { status: IntegrityStatus.OK, detail: null };
}

/**
 * Resolves one token to a verdict, decoding it at most once ever.
 *
 * Order is deliberate: in-process promise, then the stored row, then the claim.
 * A stored row that is still 'decoding' means another process owns it, so we
 * poll for a bounded time rather than decode in parallel - polling wastes a few
 * hundred milliseconds, decoding twice destroys the verdict.
 */
async function resolveVerdict(tokenSha256, token, context) {
  const existing = await integrityVerdictModel.get(tokenSha256);

  if (existing && existing.status === "done") {
    if (existing.verdict_usable && existing.verdict) {
      // Legitimate reuse is narrow: the same token, for the same request, still
      // inside the reuse window. That is SEC-0.1's 401 retry. Anything else
      // presenting this token again is a replay, and is reported as one.
      if (existing.request_hash && existing.request_hash !== context.requestHash) {
        return { replayed: true, detail: "different_request" };
      }
      return { verdict: existing.verdict, cached: true };
    }
    return { replayed: true, detail: "verdict_expired" };
  }

  const { claimed } = await integrityVerdictModel.claim(tokenSha256, context);

  if (!claimed) {
    for (let i = 0; i < config.pollAttempts; i += 1) {
      await sleep(config.pollIntervalMs);
      const row = await integrityVerdictModel.get(tokenSha256);
      if (row && row.status === "done") {
        if (row.verdict_usable && row.verdict) {
          return { verdict: row.verdict, cached: true };
        }
        return { replayed: true, detail: "verdict_expired" };
      }
    }
    return { unavailable: true, detail: "claim_held_elsewhere" };
  }

  if (!consumeDecodeBudget(context.budgetKey)) {
    // Leave the row 'decoding'; stale-claim recovery reclaims it later. We do
    // not mark it done, because we learned nothing about this token.
    return { unavailable: true, detail: "decode_budget_exhausted" };
  }

  const decoded = await playIntegrityService.decodeToken(token);

  if (!decoded.ok) {
    const status = decoded.unavailable
      ? IntegrityStatus.DECODE_UNAVAILABLE
      : IntegrityStatus.DECODE_FAILED;
    await integrityVerdictModel.complete(tokenSha256, { verdict: null, outcome: status });
    return { unavailable: decoded.unavailable, failed: !decoded.unavailable, detail: decoded.detail };
  }

  await integrityVerdictModel.complete(tokenSha256, {
    verdict: decoded.verdict,
    outcome: "decoded",
  });
  return { verdict: decoded.verdict, cached: false };
}

/**
 * The middleware. Total by construction: every path ends in next().
 *
 * A thrown error here would take down a generation or a login over a
 * defence-in-depth signal, which is the opposite of the intent - so the whole
 * body is wrapped, and the catch annotates rather than propagates.
 */
function verifyIntegrity(req, res, next) {
  const endpoint = `${req.method} ${req.baseUrl}${req.path === "/" ? "" : req.path}`;
  // Set once the token is hashed, so every later annotation carries it. A
  // 12-char digest prefix correlates two sightings of the same token without
  // being the token - the raw value never reaches a log or the database.
  let tokenDigest = null;
  const annotate = (status, extra = {}) => {
    req.integrity = {
      status,
      endpoint,
      verdict: null,
      detail: null,
      cached: false,
      tokenDigest,
      ...extra,
    };
  };

  (async () => {
    if (!isConfigured()) {
      annotate(IntegrityStatus.ABSENT, { detail: "not_configured" });
      return;
    }

    const token = req.get(HEADER);
    if (!token) {
      annotate(IntegrityStatus.ABSENT, { detail: "header_missing" });
      return;
    }
    if (token.length < MIN_TOKEN_LENGTH || token.length > MAX_TOKEN_LENGTH) {
      annotate(IntegrityStatus.MALFORMED, { detail: "implausible_length" });
      return;
    }

    const canonical = canonicalRequestFor(req);
    if (canonical === null) {
      // A route was wired to this middleware without a canonical-string rule.
      // Reported as unavailable rather than a mismatch: it is our bug, not the
      // caller's, and SEC-0.5 must not deny a user over it.
      annotate(IntegrityStatus.DECODE_UNAVAILABLE, { detail: "no_canonical_rule" });
      return;
    }

    const expectedRequestHash = sha256Base64Url(canonical);
    const tokenSha256 = playIntegrityService.hashToken(token);
    tokenDigest = tokenSha256.slice(0, 12);

    // SEC-0.4: opportunistic retention sweep, rate-limited to once an hour and
    // never awaited. Placed here rather than at the top of the middleware so it
    // only runs on requests that actually write to the ledger.
    integrityLedgerSweeper.maybeSweep();
    const budgetKey = (req.user && req.user.id) || req.ip || "unknown";
    pruneDecodeBudget();

    const context = {
      requestHash: expectedRequestHash,
      endpoint,
      userId: (req.user && req.user.id) || null,
      budgetKey,
    };

    let outcome;
    const pending = inFlight.get(tokenSha256);
    if (pending) {
      outcome = await pending;
    } else {
      const promise = resolveVerdict(tokenSha256, token, context).catch((err) => ({
        unavailable: true,
        detail: "resolve_error",
        error: err && err.message,
      }));
      inFlight.set(tokenSha256, promise);
      try {
        outcome = await promise;
      } finally {
        inFlight.delete(tokenSha256);
      }
    }

    if (outcome.replayed) {
      annotate(IntegrityStatus.REPLAYED, { detail: outcome.detail });
      return;
    }
    if (outcome.unavailable) {
      annotate(IntegrityStatus.DECODE_UNAVAILABLE, { detail: outcome.detail });
      return;
    }
    if (outcome.failed) {
      annotate(IntegrityStatus.DECODE_FAILED, { detail: outcome.detail });
      return;
    }

    const validation = validateVerdict(outcome.verdict, { expectedRequestHash });
    annotate(validation.status, {
      detail: validation.detail,
      verdict: outcome.verdict,
      cached: Boolean(outcome.cached),
    });
  })()
    .catch((err) => {
      // Belt and braces. The IIFE above already catches its own resolution
      // errors; this exists so that a bug in the annotation path itself still
      // cannot reject a paying user's generation.
      annotate(IntegrityStatus.DECODE_UNAVAILABLE, { detail: "middleware_error" });
      console.error("[verifyIntegrity] unexpected error:", err && err.message);
    })
    .then(() => {
      try {
        logIntegrity(req, req.integrity);
      } catch (_) {
        // Logging must never be the reason a request fails.
      }
      next();
    });
}

module.exports = verifyIntegrity;
module.exports.IntegrityStatus = IntegrityStatus;
module.exports.__testing = { canonicalRequestFor, validateVerdict, sha256Base64Url, inFlight, decodeBudget };
