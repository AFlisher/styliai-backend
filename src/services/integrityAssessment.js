const {
  AppState,
  DeviceState,
  LicensingState,
  IntegrityState,
  STATUS_TO_STATE,
  ATTRIBUTABLE_TO_CALLER,
  APP_RECOGNITION,
  DEVICE_LABELS,
  DEVICE_RANK,
  DEVICE_STATES_MEETING_INTEGRITY,
  LICENSING,
} = require("../config/integrityVerdictMap");

/**
 * SEC-0.3 — interpretation.
 *
 *   SEC-0.2 verification  →  req.integrity  →  [ here ]  →  SEC-0.5 policy
 *
 * This module answers one question: given facts SEC-0.2 already verified, what
 * do they *mean*? It answers in a small, closed vocabulary that SEC-0.5 can
 * branch on without ever touching a Google string.
 *
 * It does not verify anything. It never calls Google, decodes a token, hashes
 * anything, or looks at a client header - it cannot, because its only input is
 * the object SEC-0.2 produced. It also decides nothing: there is no notion here
 * of allowed, denied, charged or blocked.
 *
 * Why the split is worth a whole module: interpretation is stable and policy is
 * not. "UNRECOGNIZED_VERSION means the binary is not ours" will be true for as
 * long as Play Integrity exists. "...therefore return 403" is a business
 * decision that will be tuned, staged by endpoint, relaxed during an incident
 * and reversed under support pressure. Fusing them means every policy change
 * risks the classifier, and the classifier is the part with no safe way to be
 * wrong.
 *
 * Total by construction: pure, synchronous, and it never throws. A malformed or
 * unrecognised input resolves to INDETERMINATE, which is the state that means
 * "we learned nothing" rather than a state that means "the caller is fine".
 */

function pickAppState(appIntegrity) {
  const raw = appIntegrity && appIntegrity.appRecognitionVerdict;
  if (typeof raw !== "string") return AppState.UNEVALUATED;
  // hasOwnProperty, not `in` or a bare lookup: a verdict string of
  // "constructor" or "toString" must not resolve through the prototype chain.
  return Object.prototype.hasOwnProperty.call(APP_RECOGNITION, raw)
    ? APP_RECOGNITION[raw]
    : AppState.UNKNOWN;
}

/**
 * Reduces the label array to one state, strongest label winning.
 *
 * An absent or empty array is COMPROMISED, not UNKNOWN. Google documents the
 * empty verdict as an affirmative signal - root, API hooking, or an emulator
 * that fails Play's checks - so reading it as "no information" would quietly
 * turn the single most important negative signal into a shrug.
 */
function pickDeviceState(deviceIntegrity) {
  const labels = deviceIntegrity && deviceIntegrity.deviceRecognitionVerdict;

  if (!Array.isArray(labels) || labels.length === 0) {
    return DeviceState.COMPROMISED;
  }

  let best = null;
  for (const label of labels) {
    if (typeof label !== "string") continue;
    const mapped = Object.prototype.hasOwnProperty.call(DEVICE_LABELS, label)
      ? DEVICE_LABELS[label]
      : DeviceState.UNKNOWN;
    if (best === null || DEVICE_RANK[mapped] > DEVICE_RANK[best]) {
      best = mapped;
    }
  }

  return best === null ? DeviceState.UNKNOWN : best;
}

function pickLicensingState(accountDetails) {
  const raw = accountDetails && accountDetails.appLicensingVerdict;
  if (typeof raw !== "string") return LicensingState.UNEVALUATED;
  return Object.prototype.hasOwnProperty.call(LICENSING, raw)
    ? LICENSING[raw]
    : LicensingState.UNKNOWN;
}

/**
 * Collapses the three axes into the single state, for the one case where
 * SEC-0.2 said the token decoded cleanly.
 *
 * Order is deliberate and is itself the classification: a modified binary is
 * the more specific and more serious finding, so it is reported even when the
 * device is also compromised. Reporting UNTRUSTED_DEVICE for a repackaged app
 * would send SEC-0.5 chasing the wrong problem.
 */
function combine(app, device) {
  if (app === AppState.MODIFIED) return IntegrityState.MODIFIED_APP;
  if (app === AppState.UNEVALUATED) return IntegrityState.UNEVALUATED;
  if (app === AppState.UNKNOWN) return IntegrityState.INDETERMINATE;

  if (!DEVICE_STATES_MEETING_INTEGRITY.includes(device)) {
    // Includes BASIC and VIRTUAL: not compromised as such, but not a
    // demonstration of integrity either. `device` keeps the detail.
    return device === DeviceState.UNKNOWN
      ? IntegrityState.INDETERMINATE
      : IntegrityState.UNTRUSTED_DEVICE;
  }

  return IntegrityState.TRUSTED;
}

/**
 * Interprets one SEC-0.2 annotation.
 *
 * @param {object|undefined} integrity - req.integrity, exactly as SEC-0.2 built it.
 * @returns {{
 *   state: string, app: string, device: string, licensing: string,
 *   attributableToCaller: boolean|null, source: string|null,
 *   deviceLabels: string[], cached: boolean, endpoint: string|null,
 *   tokenDigest: string|null, reason: string|null
 * }}
 */
function assessIntegrity(integrity) {
  const base = {
    state: IntegrityState.INDETERMINATE,
    app: AppState.UNEVALUATED,
    device: DeviceState.UNEVALUATED,
    licensing: LicensingState.UNEVALUATED,
    attributableToCaller: false,
    source: null,
    deviceLabels: [],
    cached: false,
    endpoint: null,
    tokenDigest: null,
    reason: null,
  };

  try {
    if (!integrity || typeof integrity !== "object" || typeof integrity.status !== "string") {
      // SEC-0.2 did not run, or ran on a route it was never wired into. Our
      // gap, not the caller's - so INDETERMINATE, and explicitly not MISSING,
      // which would imply we looked for a token and found none.
      return { ...base, reason: "no_integrity_annotation" };
    }

    const shared = {
      source: integrity.status,
      cached: Boolean(integrity.cached),
      endpoint: integrity.endpoint || null,
      tokenDigest: integrity.tokenDigest || null,
      reason: integrity.detail || null,
    };

    if (!Object.prototype.hasOwnProperty.call(STATUS_TO_STATE, integrity.status)) {
      // A taxonomy code added to SEC-0.2 without updating this table. Fails to
      // "we learned nothing" rather than to "fine".
      return {
        ...base,
        ...shared,
        state: IntegrityState.INDETERMINATE,
        reason: "unmapped_status",
      };
    }

    const direct = STATUS_TO_STATE[integrity.status];
    if (direct !== null) {
      return {
        ...base,
        ...shared,
        state: direct,
        attributableToCaller: ATTRIBUTABLE_TO_CALLER[direct],
      };
    }

    // INTEGRITY_OK: SEC-0.2 validated the envelope (package, request hash,
    // freshness). What the verdict actually says is this layer's job.
    const verdict = integrity.verdict;
    if (!verdict || typeof verdict !== "object") {
      return { ...base, ...shared, state: IntegrityState.INDETERMINATE, reason: "ok_without_verdict" };
    }

    const app = pickAppState(verdict.appIntegrity);
    const device = pickDeviceState(verdict.deviceIntegrity);
    const licensing = pickLicensingState(verdict.accountDetails);
    const state = combine(app, device);

    const rawLabels =
      verdict.deviceIntegrity && Array.isArray(verdict.deviceIntegrity.deviceRecognitionVerdict)
        ? verdict.deviceIntegrity.deviceRecognitionVerdict.filter((l) => typeof l === "string")
        : [];

    return {
      ...base,
      ...shared,
      state,
      app,
      device,
      licensing,
      deviceLabels: rawLabels,
      attributableToCaller: ATTRIBUTABLE_TO_CALLER[state],
    };
  } catch (err) {
    // Unreachable by design - every lookup above is guarded - but a classifier
    // that can throw is a classifier that can take down a generation, so the
    // failure mode is pinned to "we learned nothing".
    return { ...base, state: IntegrityState.INDETERMINATE, reason: "assessment_error" };
  }
}

module.exports = {
  assessIntegrity,
  AppState,
  DeviceState,
  LicensingState,
  IntegrityState,
};
