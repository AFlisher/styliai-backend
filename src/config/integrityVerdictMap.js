/**
 * SEC-0.3 — the verdict → normalized-state mapping table.
 *
 * This file is data, deliberately. Every string Google can send us is written
 * down here exactly once, so adding a future verdict label is an edit to a
 * table rather than a hunt for scattered `=== "PLAY_RECOGNIZED"` comparisons
 * across controllers.
 *
 * It contains NO policy. Nothing here says "reject", "allow", "charge" or
 * "deny". It says what a verdict *means*; SEC-0.5 decides what that is worth.
 * The distinction matters because policy changes often and under pressure,
 * while the meaning of MEETS_DEVICE_INTEGRITY does not.
 *
 * Source of truth: https://developer.android.com/google/play/integrity/verdicts
 */

/** How much the app binary itself can be trusted. */
const AppState = Object.freeze({
  RECOGNIZED: "RECOGNIZED",   // Play-distributed, unmodified binary and certificate
  MODIFIED: "MODIFIED",       // a repackaged or otherwise unrecognised build
  UNEVALUATED: "UNEVALUATED", // Google did not assess it
  UNKNOWN: "UNKNOWN",         // a label Google added after this table was written
});

/** How much the device can be trusted to enforce app integrity. */
const DeviceState = Object.freeze({
  STRONG: "STRONG",           // hardware-backed
  CERTIFIED: "CERTIFIED",     // genuine, certified Android device
  BASIC: "BASIC",             // weaker signal, opt-in
  VIRTUAL: "VIRTUAL",         // an emulator Google recognises, opt-in
  COMPROMISED: "COMPROMISED", // empty verdict: rooted, hooked, or a failing emulator
  UNEVALUATED: "UNEVALUATED",
  UNKNOWN: "UNKNOWN",
});

/** Whether this Play account holds a licence for the app. */
const LicensingState = Object.freeze({
  LICENSED: "LICENSED",
  UNLICENSED: "UNLICENSED",
  UNEVALUATED: "UNEVALUATED",
  UNKNOWN: "UNKNOWN",
});

/**
 * The single normalized state SEC-0.5 will branch on.
 *
 * Exhaustive by construction: every SEC-0.2 taxonomy code and every verdict
 * combination resolves to exactly one of these, and anything unrecognised
 * lands on INDETERMINATE rather than crashing or silently reading as trusted.
 */
const IntegrityState = Object.freeze({
  /** Play-recognised app on a device that meets integrity. The only clean state. */
  TRUSTED: "TRUSTED",

  /** The binary is not the one Google distributes - repackaged or tampered. */
  MODIFIED_APP: "MODIFIED_APP",

  /** Genuine app, but the device shows root, hooking, or is a failing emulator. */
  UNTRUSTED_DEVICE: "UNTRUSTED_DEVICE",

  /** The request did not match what the token attested, or the token was old. */
  TAMPERED_REQUEST: "TAMPERED_REQUEST",

  /** The same token was presented again outside its legitimate retry. */
  REPLAYED: "REPLAYED",

  /** No token arrived at all. Ambiguous by nature - could be a stripped header
   *  or a device with no working Play Services. SEC-0.5 owns that judgement. */
  MISSING: "MISSING",

  /** Google returned a payload but declined to evaluate it. */
  UNEVALUATED: "UNEVALUATED",

  /** We could not obtain a verdict for reasons that are ours or Google's -
   *  a timeout, an outage, an exhausted quota, a configuration gap. Never the
   *  caller's fault, and must never be confused with the states above. */
  INDETERMINATE: "INDETERMINATE",
});

/**
 * SEC-0.2 taxonomy code → the state it resolves to on its own.
 *
 * `null` means "the code alone does not decide" - the verdict payload has to be
 * read. Only INTEGRITY_OK is in that position.
 */
const STATUS_TO_STATE = Object.freeze({
  INTEGRITY_OK: null,
  INTEGRITY_ABSENT: IntegrityState.MISSING,
  INTEGRITY_MALFORMED: IntegrityState.TAMPERED_REQUEST,
  INTEGRITY_STALE: IntegrityState.TAMPERED_REQUEST,
  INTEGRITY_REQUEST_MISMATCH: IntegrityState.TAMPERED_REQUEST,
  INTEGRITY_PACKAGE_MISMATCH: IntegrityState.MODIFIED_APP,
  INTEGRITY_REPLAYED: IntegrityState.REPLAYED,
  INTEGRITY_DECODE_FAILED: IntegrityState.TAMPERED_REQUEST,
  INTEGRITY_DECODE_UNAVAILABLE: IntegrityState.INDETERMINATE,
});

/**
 * Whether a state is the caller's doing.
 *
 * Carried through from SEC-0.2's central distinction: INDETERMINATE is our
 * failure or Google's, MISSING is genuinely ambiguous, and everything else
 * points at whoever sent the request. This is classification, not policy - it
 * says who caused the state, not what to do about it.
 */
const ATTRIBUTABLE_TO_CALLER = Object.freeze({
  [IntegrityState.TRUSTED]: false,
  [IntegrityState.MODIFIED_APP]: true,
  [IntegrityState.UNTRUSTED_DEVICE]: true,
  [IntegrityState.TAMPERED_REQUEST]: true,
  [IntegrityState.REPLAYED]: true,
  [IntegrityState.MISSING]: null, // genuinely unknown; SEC-0.5 decides
  [IntegrityState.UNEVALUATED]: null,
  [IntegrityState.INDETERMINATE]: false,
});

/** appIntegrity.appRecognitionVerdict → AppState. */
const APP_RECOGNITION = Object.freeze({
  PLAY_RECOGNIZED: AppState.RECOGNIZED,
  UNRECOGNIZED_VERSION: AppState.MODIFIED,
  UNEVALUATED: AppState.UNEVALUATED,
});

/**
 * deviceIntegrity.deviceRecognitionVerdict labels → DeviceState.
 *
 * The field is an array and may carry several labels at once; the strongest
 * wins (see DEVICE_RANK). An absent or empty array is not "unknown" - Google
 * documents it as a positive signal of root, API hooking, or an emulator that
 * fails Play's checks, so it maps to COMPROMISED.
 */
const DEVICE_LABELS = Object.freeze({
  MEETS_STRONG_INTEGRITY: DeviceState.STRONG,
  MEETS_DEVICE_INTEGRITY: DeviceState.CERTIFIED,
  MEETS_BASIC_INTEGRITY: DeviceState.BASIC,
  MEETS_VIRTUAL_INTEGRITY: DeviceState.VIRTUAL,
});

/** Higher wins when several labels are present. UNKNOWN sits below everything real. */
const DEVICE_RANK = Object.freeze({
  [DeviceState.STRONG]: 5,
  [DeviceState.CERTIFIED]: 4,
  [DeviceState.BASIC]: 3,
  [DeviceState.VIRTUAL]: 2,
  [DeviceState.UNKNOWN]: 1,
  [DeviceState.COMPROMISED]: 0,
  [DeviceState.UNEVALUATED]: 0,
});

/**
 * Which device states count as "the device can enforce app integrity" when
 * deciding TRUSTED.
 *
 * BASIC and VIRTUAL are deliberately excluded. That is a *classification*
 * choice, not policy: a device that meets only basic integrity has not shown
 * it is uncompromised, and a recognised emulator is by definition not a
 * physical device. Both remain fully visible to SEC-0.5 in `device`, so a
 * policy that wants to accept them can - it just has to say so explicitly
 * rather than inherit it silently from this table.
 */
const DEVICE_STATES_MEETING_INTEGRITY = Object.freeze([
  DeviceState.STRONG,
  DeviceState.CERTIFIED,
]);

/** accountDetails.appLicensingVerdict → LicensingState. */
const LICENSING = Object.freeze({
  LICENSED: LicensingState.LICENSED,
  UNLICENSED: LicensingState.UNLICENSED,
  UNEVALUATED: LicensingState.UNEVALUATED,
});

module.exports = {
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
};
