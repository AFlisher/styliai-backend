const { IntegrityState } = require("../services/integrityAssessment");

/**
 * SEC-0.5 — the policy table.
 *
 *   verify (0.2) → interpret (0.3) → [ policy, here ] → enforce
 *
 * This is the first layer allowed to have an opinion about consequences.
 * Everything upstream describes; this decides. It is deliberately data, so that
 * staging enforcement, relaxing it during an incident, or turning it off
 * entirely is a configuration change rather than a code change.
 *
 * No endpoint name appears anywhere outside this file.
 */

/**
 * The four rungs, weakest first.
 *
 *   LOG        record and continue. The observation-only rung.
 *   WARN       record at elevated severity and continue. Same user experience
 *              as LOG; exists so alerting can fire before anyone is denied.
 *   SOFT_FAIL  allow the request, but mark it degraded on req.integrityPolicy
 *              so a later consumer can withhold something specific (a credit
 *              grant, say) without refusing the whole call. Nothing consumes
 *              this yet - it is the rung that makes a staged rollout meaningful
 *              rather than a jump from "logging" to "denying".
 *   HARD_FAIL  refuse the request.
 *
 * Only HARD_FAIL blocks. That is the whole difference between the top rung and
 * the other three.
 */
const EnforcementAction = Object.freeze({
  LOG: "log",
  WARN: "warn",
  SOFT_FAIL: "soft_fail",
  HARD_FAIL: "hard_fail",
});

const SEVERITY = Object.freeze({
  [EnforcementAction.LOG]: 0,
  [EnforcementAction.WARN]: 1,
  [EnforcementAction.SOFT_FAIL]: 2,
  [EnforcementAction.HARD_FAIL]: 3,
});

const BY_SEVERITY = Object.freeze(
  Object.keys(SEVERITY).sort((a, b) => SEVERITY[a] - SEVERITY[b])
);

/**
 * What each normalized state *deserves*, before any endpoint or global ceiling
 * is applied. Exhaustive over SEC-0.3's vocabulary.
 *
 * The three states that stay at LOG are the ones where punishing the caller
 * would be punishing the wrong party:
 *
 *   INDETERMINATE  our failure or Google's - a timeout, an outage, an
 *                  exhausted quota. Denying here converts a Google incident
 *                  into a StyliAI outage.
 *   MISSING        genuinely ambiguous. A stripped header and a device with
 *                  broken Play Services are indistinguishable, and until the
 *                  telemetry says otherwise, most of these are honest users.
 *   UNEVALUATED    Google declined to assess; we know nothing.
 *
 * Raising any of those three is a decision to be made from real verdict
 * distribution data, not from first principles.
 */
const STATE_ACTIONS = Object.freeze({
  [IntegrityState.TRUSTED]: EnforcementAction.LOG,
  [IntegrityState.MODIFIED_APP]: EnforcementAction.HARD_FAIL,
  [IntegrityState.UNTRUSTED_DEVICE]: EnforcementAction.SOFT_FAIL,
  [IntegrityState.TAMPERED_REQUEST]: EnforcementAction.HARD_FAIL,
  [IntegrityState.REPLAYED]: EnforcementAction.HARD_FAIL,
  [IntegrityState.MISSING]: EnforcementAction.LOG,
  [IntegrityState.UNEVALUATED]: EnforcementAction.LOG,
  [IntegrityState.INDETERMINATE]: EnforcementAction.LOG,
});

/**
 * Per-endpoint ceiling. An endpoint can never act more harshly than its
 * ceiling, so a staged rollout is just raising this value over time:
 *
 *   log → warn → soft_fail → hard_fail
 *
 * Keys are route-shaped, matching the `endpoint` string SEC-0.2 builds.
 * Anything not listed falls back to DEFAULT_CEILING.
 */
const ENDPOINT_CEILINGS = Object.freeze({
  // Highest volume, most latency-sensitive, and the one where a false denial
  // locks a real user out of their account entirely. Starts as observation.
  "POST /api/auth/login": EnforcementAction.LOG,

  // Both spend real provider money per call, so they carry the strongest
  // incentive to abuse and the clearest cost when abused.
  "POST /api/generate": EnforcementAction.HARD_FAIL,
  "POST /api/ai/generate": EnforcementAction.HARD_FAIL,

  // Grants credits from an ad view - directly monetary.
  "POST /api/wallet/reward": EnforcementAction.HARD_FAIL,
});

/**
 * Anything wired to the middleware but absent from the table above.
 *
 * LOG, deliberately: a route that reaches enforcement without anyone having
 * decided its policy must not start denying users by accident. Admin routes,
 * if ever added, land here - and note that the admin dashboard is a web client
 * with no Play Integrity at all, so every request would be MISSING. Raising
 * their ceiling without that in mind would lock the dashboard out.
 */
const DEFAULT_CEILING = EnforcementAction.LOG;

/**
 * Global kill switch, shared with SEC-0.2's config.
 *
 *   off      no enforcement at all
 *   log      everything capped at observation, whatever the tables say
 *   enforce  tables apply as written
 *
 * This is the rollback that matters: one Railway variable, effective on
 * restart, no deploy and no app-store release.
 */
const GLOBAL_CEILINGS = Object.freeze({
  off: EnforcementAction.LOG,
  log: EnforcementAction.LOG,
  enforce: EnforcementAction.HARD_FAIL,
});

/**
 * Per-endpoint overrides from the environment, so a single endpoint can be
 * staged or rolled back without a deploy.
 *
 * Format: PLAY_INTEGRITY_POLICY_OVERRIDES="POST /api/generate=log,POST /api/wallet/reward=warn"
 * A malformed entry is ignored with a warning rather than throwing - a typo in
 * an env var must not stop the process booting.
 */
function parseOverrides(raw) {
  const out = {};
  if (!raw || typeof raw !== "string") return Object.freeze(out);

  for (const clause of raw.split(",")) {
    const trimmed = clause.trim();
    if (!trimmed) continue;
    const idx = trimmed.lastIndexOf("=");
    if (idx <= 0) {
      console.warn(`[integrityPolicy] ignoring malformed override: "${trimmed}"`);
      continue;
    }
    const endpoint = trimmed.slice(0, idx).trim();
    const action = trimmed.slice(idx + 1).trim().toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(SEVERITY, action)) {
      console.warn(`[integrityPolicy] ignoring unknown action "${action}" for "${endpoint}"`);
      continue;
    }
    out[endpoint] = action;
  }
  return Object.freeze(out);
}

/**
 * Signing-certificate allowlist, base64url SHA-256 digests as Google reports
 * them in appIntegrity.certificateSha256Digest.
 *
 * Empty means the check is inert, which is the shipping state: the digests are
 * only knowable once the app is on a Play track. This lives in SEC-0.5 rather
 * than SEC-0.3 because "which certificates are ours" is policy, not
 * interpretation - it changes when signing keys rotate.
 */
function parseCertificateAllowlist(raw) {
  if (!raw || typeof raw !== "string") return Object.freeze([]);
  return Object.freeze(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  );
}

const overrides = parseOverrides(process.env.PLAY_INTEGRITY_POLICY_OVERRIDES);
const certificateAllowlist = parseCertificateAllowlist(
  process.env.PLAY_INTEGRITY_CERT_SHA256
);

function weakest(...actions) {
  return actions.reduce((a, b) => (SEVERITY[a] <= SEVERITY[b] ? a : b));
}

function ceilingFor(endpoint) {
  if (Object.prototype.hasOwnProperty.call(overrides, endpoint)) {
    return overrides[endpoint];
  }
  if (Object.prototype.hasOwnProperty.call(ENDPOINT_CEILINGS, endpoint)) {
    return ENDPOINT_CEILINGS[endpoint];
  }
  return DEFAULT_CEILING;
}

/**
 * Resolves the action for one assessed request.
 *
 * effective = weakest(what the state deserves, endpoint ceiling, global ceiling)
 *
 * Taking the weakest is what makes staged rollout expressible purely in
 * configuration, and it means no combination of tables can ever act more
 * harshly than the global switch allows.
 *
 * @returns {{action: string, deserved: string, endpointCeiling: string,
 *            globalCeiling: string, endpoint: string, reason: string}}
 */
function resolveAction({ state, endpoint, enforcement }) {
  const globalCeiling = Object.prototype.hasOwnProperty.call(GLOBAL_CEILINGS, enforcement)
    ? GLOBAL_CEILINGS[enforcement]
    : EnforcementAction.LOG;

  // An unknown state - one SEC-0.3 grows later - must not silently become
  // harmless. LOG is the safe default for the *user*, and the mismatch is
  // surfaced in `reason` so it shows up in the logs rather than passing unseen.
  const known = Object.prototype.hasOwnProperty.call(STATE_ACTIONS, state);
  const deserved = known ? STATE_ACTIONS[state] : EnforcementAction.LOG;

  const endpointCeiling = ceilingFor(endpoint);

  return {
    action: weakest(deserved, endpointCeiling, globalCeiling),
    deserved,
    endpointCeiling,
    globalCeiling,
    endpoint,
    reason: known ? null : "unmapped_state",
  };
}

module.exports = {
  EnforcementAction,
  SEVERITY,
  BY_SEVERITY,
  STATE_ACTIONS,
  ENDPOINT_CEILINGS,
  DEFAULT_CEILING,
  GLOBAL_CEILINGS,
  resolveAction,
  ceilingFor,
  weakest,
  certificateAllowlist,
  overrides,
  __testing: { parseOverrides, parseCertificateAllowlist },
};
