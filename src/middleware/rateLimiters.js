const { rateLimit, ipKeyGenerator, MINUTE, HOUR } = require("express-rate-limit");
const { ErrorCodes } = require("../utils/errors");

/**
 * Every limiter in this file returns this same JSON shape on 429, matching
 * the {code, message} contract the global error handler in app.js already
 * uses for every other error - so callers never have to special-case rate
 * limit responses. standardHeaders adds the draft-7 RateLimit/Retry-After
 * headers; legacyHeaders is off since nothing in this codebase reads the
 * old X-RateLimit-prefixed headers.
 */
function jsonRateLimitHandler(message) {
  return (req, res) => {
    res.status(429).json({ code: ErrorCodes.RATE_LIMITED, message });
  };
}

/**
 * Keys authenticated write endpoints by user id (set by authMiddleware,
 * which always runs before these limiters) instead of IP, since several
 * real users legitimately share one IP behind carrier-grade NAT / campus
 * wifi and would otherwise throttle each other. ipKeyGenerator normalizes
 * IPv6 correctly for the anonymous fallback, same as express-rate-limit's
 * own default keyGenerator does internally.
 */
function userOrIpKeyGenerator(req) {
  return (req.user && req.user.id) || ipKeyGenerator(req.ip);
}

const baseOptions = {
  standardHeaders: true,
  legacyHeaders: false,
};

// Single source of truth for every limiter's configured window/limit, keyed
// by the same name it's exported under below. Built up by makeLimiter() as
// each one is defined, so the numbers below can never drift from what's
// actually enforced - tests and docs read this instead of duplicating the
// values by hand.
const LIMIT_VALUES = {};

function makeLimiter(name, { windowMs, limit, message, keyGenerator }) {
  LIMIT_VALUES[name] = { windowMs, limit };
  return rateLimit({
    ...baseOptions,
    windowMs,
    limit,
    ...(keyGenerator ? { keyGenerator } : {}),
    handler: jsonRateLimitHandler(message),
  });
}

// ---------------------------------------------------------------------------
// Authentication (src/routes/authRoutes.js)
// ---------------------------------------------------------------------------

// Password brute-force protection. 10/15min is tight enough to make
// credential stuffing impractical while comfortably covering a real user
// who mistypes their password a few times.
const loginLimiter = makeLimiter("loginLimiter", {
  windowMs: 15 * MINUTE,
  limit: 10,
  message: "Too many login attempts. Please try again in 15 minutes.",
});

// Account creation is cheap to abuse (fake accounts, email-bombing via the
// verification email) but rare for a genuine user to do more than once.
const registerLimiter = makeLimiter("registerLimiter", {
  windowMs: HOUR,
  limit: 5,
  message: "Too many registration attempts. Please try again in an hour.",
});

// Sends a real reset email per hit and is a user-enumeration probe (the
// endpoint already defends the response body itself, this bounds the probe
// rate too).
const forgotPasswordLimiter = makeLimiter("forgotPasswordLimiter", {
  windowMs: HOUR,
  limit: 5,
  message: "Too many password reset requests. Please try again in an hour.",
});

// Shared by GET /reset-password (renders the form for a token from the
// email link) and POST /reset-password (submits the new password). Both
// sides of this flow are guessing surface for the reset token, so they
// share one budget rather than getting 5 attempts each.
const resetPasswordLimiter = makeLimiter("resetPasswordLimiter", {
  windowMs: HOUR,
  limit: 5,
  message: "Too many password reset attempts. Please try again in an hour.",
});

// Shared by GET /verify (consumes the emailed token) and POST
// /resend-verification (sends a new one) - both gate the same "send/consume
// a verification email" action pair.
const emailVerificationLimiter = makeLimiter("emailVerificationLimiter", {
  windowMs: HOUR,
  limit: 20,
  message: "Too many verification requests. Please try again later.",
});

// GET /status is polled every 2s by the mobile app's email-verification
// waiting screen (see lib/screens/email_verification_screen.dart) for as
// long as that screen stays open - roughly 30 requests/minute from one
// device. This is NOT the same risk bucket as the other auth endpoints
// above (no email sent, no token consumed, no password checked - just a
// boolean read), so it gets its own generous limiter instead of being
// folded into emailVerificationLimiter's 20/hour, which the app's own
// intended usage would blow through in two minutes.
const statusPollLimiter = makeLimiter("statusPollLimiter", {
  windowMs: MINUTE,
  limit: 90,
  message: "Too many status checks. Please slow down.",
});

// Refresh tokens are short-lived on purpose (1h access token), so one
// active device refreshes roughly hourly - 100/15min/IP leaves huge
// headroom for many users behind one NAT/proxy IP while still bounding a
// runaway client retry loop.
const refreshLimiter = makeLimiter("refreshLimiter", {
  windowMs: 15 * MINUTE,
  limit: 100,
  message: "Too many token refresh attempts. Please try again later.",
});

// Google sign-in can't be password-brute-forced (Google verifies the ID
// token), but each attempt still costs a call out to Google plus DB writes,
// so it gets a lighter version of the login limiter rather than none at all.
const googleSignInLimiter = makeLimiter("googleSignInLimiter", {
  windowMs: 15 * MINUTE,
  limit: 20,
  message: "Too many sign-in attempts. Please try again later.",
});

// Authenticated account-mutation actions (logout, change-password). Both
// are cheap individually but change-password does a bcrypt compare + hash
// per call, so this bounds CPU burn from a hammering script even though the
// caller is already authenticated.
const accountActionLimiter = makeLimiter("accountActionLimiter", {
  windowMs: 15 * MINUTE,
  limit: 30,
  message: "Too many requests. Please try again later.",
});

// ---------------------------------------------------------------------------
// Image generation (src/routes/generateRoutes.js, src/routes/stabilityRoutes.js)
// ---------------------------------------------------------------------------

// Every request here reaches a metered third-party AI provider (fal/Gemini/
// Stability). 20/min/IP bounds provider spend and abuse while staying well
// above what a real user (or a few sharing an IP) would generate by hand;
// see concurrentGenerationLimiter for the complementary per-user in-flight cap.
const generationLimiter = makeLimiter("generationLimiter", {
  windowMs: MINUTE,
  limit: 20,
  message: "Too many generation requests. Please wait a moment and try again.",
});

// Admin-only "Test Prompt" tool (POST /api/admin/ai/generate-preview) - no
// wallet charge, so the only thing bounding its cost is this limiter.
// Tighter than the user-facing generation limiter since it's an internal
// testing aid, not a product feature under normal load.
const adminGenerationPreviewLimiter = makeLimiter("adminGenerationPreviewLimiter", {
  windowMs: MINUTE,
  limit: 10,
  message: "Too many preview requests. Please wait a moment and try again.",
});

// ---------------------------------------------------------------------------
// Uploads (src/routes/uploadRoutes.js)
// ---------------------------------------------------------------------------

const uploadLimiter = makeLimiter("uploadLimiter", {
  windowMs: MINUTE,
  limit: 30,
  message: "Too many upload requests. Please wait a moment and try again.",
});

// ---------------------------------------------------------------------------
// Wallet / Credits (src/routes/walletRoutes.js)
// ---------------------------------------------------------------------------

// POST /api/wallet/reward/verify is Google AdMob's server-to-server SSV
// callback, not a user request - it arrives from Google's own infrastructure
// on behalf of potentially many different app users sharing a small set of
// caller IPs. A tight per-IP limit here would risk dropping legitimate
// reward callbacks for OTHER users during high ad-watch volume. The real
// abuse protection for this endpoint is the cryptographic signature check
// and the idempotent transaction_id claim in walletController - both
// already in place. This limiter is only a generous backstop against raw
// request-flood DoS, not an economic-abuse control.
const ssvCallbackLimiter = makeLimiter("ssvCallbackLimiter", {
  windowMs: MINUTE,
  limit: 200,
  message: "Too many requests.",
});

// POST /api/wallet/reward (client-claimed reward path, disabled in
// production unless ENABLE_CLIENT_AD_REWARD=true). Keyed by user id, not
// IP: the real economic limit is already enforced server-side by
// walletService.rewardAd's daily cap, so this only needs to stop one
// account from hammering the endpoint.
const rewardClaimLimiter = makeLimiter("rewardClaimLimiter", {
  windowMs: 15 * MINUTE,
  limit: 20,
  keyGenerator: userOrIpKeyGenerator,
  message: "Too many reward requests. Please try again later.",
});

// ---------------------------------------------------------------------------
// Public read-only catalog endpoints (categories, styles, credit packs)
// ---------------------------------------------------------------------------

// The mobile Home screen fires several of these in quick succession on load
// (categories, trending styles, recommended styles) and again per category
// filter tap, so this needs real headroom - it's cheap, cacheable-shaped
// catalog data, not a sensitive or expensive operation.
const publicReadLimiter = makeLimiter("publicReadLimiter", {
  windowMs: MINUTE,
  limit: 300,
  message: "Too many requests. Please slow down.",
});

// ---------------------------------------------------------------------------
// Authenticated user-profile data (creations, favorites, notifications,
// wallet reads)
// ---------------------------------------------------------------------------

const userDataLimiter = makeLimiter("userDataLimiter", {
  windowMs: MINUTE,
  limit: 120,
  message: "Too many requests. Please slow down.",
});

// ---------------------------------------------------------------------------
// Admin (src/routes/adminRoutes.js and admin-gated routes in
// category/style/tag/creditPack routes)
// ---------------------------------------------------------------------------

// Admin accounts are a higher-value target than regular users (full
// balance-adjustment and catalog-management power), so login is tighter
// than the already-strict user loginLimiter above.
const adminLoginLimiter = makeLimiter("adminLoginLimiter", {
  windowMs: 15 * MINUTE,
  limit: 10,
  message: "Too many login attempts. Please try again in 15 minutes.",
});

// Covers the rest of the admin-authenticated surface (stats, user search,
// balance adjustment, category/style/tag CRUD). Generous enough for a staff
// member actively working the dashboard (search-as-you-type, bulk reorder),
// strict enough to contain a compromised admin token or a runaway dashboard
// bug rather than a plausible real workload.
const adminActionLimiter = makeLimiter("adminActionLimiter", {
  windowMs: MINUTE,
  limit: 100,
  message: "Too many admin requests. Please slow down.",
});

module.exports = {
  loginLimiter,
  registerLimiter,
  forgotPasswordLimiter,
  resetPasswordLimiter,
  emailVerificationLimiter,
  statusPollLimiter,
  refreshLimiter,
  googleSignInLimiter,
  accountActionLimiter,
  generationLimiter,
  adminGenerationPreviewLimiter,
  uploadLimiter,
  ssvCallbackLimiter,
  rewardClaimLimiter,
  publicReadLimiter,
  userDataLimiter,
  adminLoginLimiter,
  adminActionLimiter,
  LIMIT_VALUES,
};
