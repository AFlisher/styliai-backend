const { logValidationFailure } = require("../../utils/securityEvents");

/**
 * SEC-18.4 - bot and automation controls on account creation.
 *
 * THE FINDING. There is no CAPTCHA, challenge, proof-of-work or behavioural
 * signal at any entry point, and no disposable-email blocklist, so any inbox
 * that can receive the verification link is acceptable. The only bound on mass
 * account creation is `registerLimiter` at 5/hour/IP - a meaningful speed bump
 * for a single origin and useless against a rotating proxy pool or
 * carrier-grade NAT.
 *
 * WHY IT IS RATED LOW, AND WHY THAT MATTERS FOR THE DESIGN. The accounts
 * obtained are worth zero on creation and yield credits only at the cost of
 * real, Google-verified ad impressions. The audit is explicit that this "flips
 * the moment a signup bonus, referral, or promo is introduced - at which point
 * registration volume becomes directly monetisable and these controls become
 * urgent rather than optional."
 *
 * That conditional is the whole reason for the shape of this file. Adding a
 * hard CAPTCHA today would impose friction on every real signup to defend
 * against an attack that is currently unprofitable - a bad trade, and one that
 * would likely be quietly removed the first time it dented conversion. So:
 *
 *   - The DISPOSABLE-DOMAIN check is on by default. It costs a legitimate user
 *     nothing (they are not signing up with a ten-minute inbox), needs no third
 *     party, and cannot fail open in a way that blocks anyone.
 *   - The CAPTCHA integration is BUILT, TESTED AND INERT until configured -
 *     the same pattern Play Integrity (SEC-0.x) uses. Turning it on is one
 *     environment variable on the day the economics change, not a project.
 */

/**
 * Disposable / throwaway email providers.
 *
 * Deliberately a small, curated list of the highest-volume offenders rather
 * than a large vendored one. A big list is a maintenance burden that goes stale
 * and eventually blocks a legitimate provider that changed hands - and the goal
 * here is to raise cost, not to be exhaustive. `DISPOSABLE_EMAIL_DOMAINS` can
 * extend it without a deploy.
 *
 * NOTE ON SUBDOMAINS: matching is on the exact registrable domain and its
 * subdomains, so `mailinator.com` also blocks `x.mailinator.com`, which is how
 * these services actually hand out addresses.
 */
const BUILT_IN_DISPOSABLE_DOMAINS = [
  "mailinator.com",
  "guerrillamail.com",
  "guerrillamail.info",
  "sharklasers.com",
  "10minutemail.com",
  "tempmail.com",
  "temp-mail.org",
  "throwawaymail.com",
  "yopmail.com",
  "getnada.com",
  "dispostable.com",
  "trashmail.com",
  "fakeinbox.com",
  "maildrop.cc",
  "mohmal.com",
  "moakt.com",
  "emailondeck.com",
  "tempinbox.com",
  "spamgourmet.com",
  "mytemp.email",
];

function buildDomainSet(env = process.env) {
  const extra = (env.DISPOSABLE_EMAIL_DOMAINS || "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  return new Set([...BUILT_IN_DISPOSABLE_DOMAINS, ...extra]);
}

let cachedDomains;

function disposableDomains(env = process.env) {
  if (!cachedDomains) cachedDomains = buildDomainSet(env);
  return cachedDomains;
}

/**
 * @returns {boolean} true when the address belongs to a known throwaway
 *   provider. Never throws on malformed input - it returns false, because
 *   address FORMAT is already validated by the Zod schema on this endpoint and
 *   this check must not become a second, subtly different validator.
 */
function isDisposableEmail(email, env = process.env) {
  if (typeof email !== "string") return false;
  const at = email.lastIndexOf("@");
  if (at < 0) return false;

  const domain = email.slice(at + 1).trim().toLowerCase();
  if (!domain) return false;

  const set = disposableDomains(env);
  if (set.has(domain)) return true;

  // Subdomain match: block x.mailinator.com when mailinator.com is listed.
  // Iterating the suffixes of the candidate rather than the whole blocklist
  // keeps this O(labels) instead of O(list).
  const parts = domain.split(".");
  for (let i = 1; i < parts.length - 1; i += 1) {
    if (set.has(parts.slice(i).join("."))) return true;
  }
  return false;
}

/**
 * Whether disposable-domain rejection is active. On by default; the escape
 * hatch exists because a support incident ("our corporate domain is on a list
 * somewhere") must be fixable in seconds.
 */
function disposableCheckEnabled(env = process.env) {
  return String(env.BLOCK_DISPOSABLE_EMAILS || "true").trim().toLowerCase() !== "false";
}

// ---------------------------------------------------------------------------
// CAPTCHA (Cloudflare Turnstile)
// ---------------------------------------------------------------------------

/**
 * Inert until `TURNSTILE_SECRET_KEY` is set - same posture as Play Integrity's
 * kill switch. When unset, `verifyCaptcha` returns `{ skipped: true }` and the
 * caller proceeds, so shipping this changes nothing for anyone until the day it
 * is deliberately switched on.
 */
function captchaEnabled(env = process.env) {
  return Boolean(env.TURNSTILE_SECRET_KEY && env.TURNSTILE_SECRET_KEY.trim());
}

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const VERIFY_TIMEOUT_MS = 5000;

/**
 * Verifies a Turnstile token.
 *
 * FAILS OPEN ON INFRASTRUCTURE FAILURE, and this is a deliberate, stated
 * choice rather than an oversight. If Cloudflare is unreachable or slow, the
 * alternatives are:
 *   - fail closed: nobody in the world can create an account while a third
 *     party is having an incident, and
 *   - fail open: for the duration of that incident, registration is bounded by
 *     `registerLimiter` alone - which is exactly the pre-Phase-8 posture, on a
 *     finding the audit rates Low and conditional.
 *
 * Reverting to a known-Low posture for minutes beats an outage of the signup
 * funnel. A REJECTED token (Cloudflare answered, and said no) is of course
 * fail-closed - that is a real answer, not an absent one. The two cases are
 * kept strictly distinct, which is the part that usually gets conflated.
 */
async function verifyCaptcha(token, { remoteIp, env = process.env } = {}) {
  if (!captchaEnabled(env)) return { ok: true, skipped: true };

  if (typeof token !== "string" || !token.trim()) {
    return { ok: false, skipped: false, reason: "missing_token" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  try {
    const body = new URLSearchParams({
      secret: env.TURNSTILE_SECRET_KEY,
      response: token.slice(0, 4096),
    });
    // The client IP is optional for Turnstile and is sent because it improves
    // its own scoring. It is NOT stored by us here - SEC-18.3's hash is the
    // only IP-derived value this system persists.
    if (remoteIp) body.set("remoteip", remoteIp);

    const res = await fetch(VERIFY_URL, {
      method: "POST",
      body,
      signal: controller.signal,
    });

    if (!res.ok) {
      return { ok: true, skipped: true, reason: "verifier_unavailable" };
    }

    const data = await res.json();
    if (data && data.success === true) return { ok: true, skipped: false };

    return {
      ok: false,
      skipped: false,
      reason: "rejected",
      // Cloudflare's own codes, useful for diagnosing a misconfiguration.
      // Bounded and allow-list-shaped: only the codes array, never the whole
      // response body.
      codes: Array.isArray(data && data["error-codes"])
        ? data["error-codes"].slice(0, 5)
        : [],
    };
  } catch (err) {
    // Timeout, DNS failure, network error. Infrastructure, not a verdict.
    return { ok: true, skipped: true, reason: "verifier_error" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Express middleware for the signup surface.
 *
 * Applied to registration and resend-verification, which is what the audit
 * names. Emits a structured validation event on rejection so
 * registration-velocity alerting (SEC-18.1) has a companion signal showing
 * whether the attempts were bot-shaped.
 */
function signupControls({ requireCaptcha = true } = {}) {
  return async function signupControlsMiddleware(req, res, next) {
    const email = req.body && req.body.email;

    if (disposableCheckEnabled() && isDisposableEmail(email)) {
      logValidationFailure(req, { code: "DISPOSABLE_EMAIL", reason: "disposable_domain" });
      return res.status(400).json({
        code: "VALIDATION_ERROR",
        // Deliberately says WHICH rule was hit. This is not an enumeration
        // oracle - it discloses nothing about whether the account exists, only
        // that the domain is unacceptable - and a user who cannot tell why
        // their signup failed will simply retry the same address.
        message: "This email provider is not supported. Please use a permanent email address.",
        requestId: req.id,
      });
    }

    if (requireCaptcha) {
      const result = await verifyCaptcha(
        req.body && (req.body.captchaToken || req.body.turnstileToken),
        { remoteIp: req.ip }
      );
      if (!result.ok) {
        logValidationFailure(req, { code: "CAPTCHA_FAILED", reason: result.reason });
        return res.status(400).json({
          code: "VALIDATION_ERROR",
          message: "Could not verify that you are human. Please try again.",
          requestId: req.id,
        });
      }
    }

    return next();
  };
}

/** Test seam. */
function resetDomainCache() {
  cachedDomains = undefined;
}

module.exports = {
  signupControls,
  isDisposableEmail,
  verifyCaptcha,
  captchaEnabled,
  disposableCheckEnabled,
  resetDomainCache,
  BUILT_IN_DISPOSABLE_DOMAINS,
};
