// SEC-0.3 — interpretation.
//
// Two properties dominate here. First, exhaustiveness: every SEC-0.2 taxonomy
// code and every verdict axis has a mapping, and the test walks the real tables
// rather than a hand-copied list, so adding a code without a mapping fails.
// Second, totality: nothing Google could invent, and nothing a malformed
// payload could contain, may throw or resolve to TRUSTED by accident.

const {
  assessIntegrity,
  AppState,
  DeviceState,
  LicensingState,
  IntegrityState,
} = require("../integrityAssessment");
const {
  STATUS_TO_STATE,
  ATTRIBUTABLE_TO_CALLER,
} = require("../../config/integrityVerdictMap");
const { IntegrityStatus } = require("../../middleware/verifyIntegrity");

function annotation(overrides = {}) {
  return {
    status: "INTEGRITY_OK",
    endpoint: "POST /api/wallet/reward",
    detail: null,
    cached: false,
    tokenDigest: "abc123def456",
    verdict: null,
    ...overrides,
  };
}

function verdict({ app = "PLAY_RECOGNIZED", device = ["MEETS_DEVICE_INTEGRITY"], licensing = "LICENSED" } = {}) {
  return {
    requestDetails: { requestHash: "h", timestampMillis: String(Date.now()) },
    appIntegrity: app === null ? {} : { appRecognitionVerdict: app, packageName: "com.prombt.prombt_app" },
    deviceIntegrity: device === null ? {} : { deviceRecognitionVerdict: device },
    accountDetails: licensing === null ? {} : { appLicensingVerdict: licensing },
  };
}

describe("compatibility with SEC-0.2", () => {
  it("maps every status SEC-0.2 can produce", () => {
    // Walks verifyIntegrity's own exported taxonomy, so a code added there
    // without a mapping here fails this test instead of silently degrading.
    for (const code of Object.values(IntegrityStatus)) {
      expect(Object.prototype.hasOwnProperty.call(STATUS_TO_STATE, code)).toBe(true);
    }
  });

  it("assigns an attributability to every normalized state", () => {
    for (const state of Object.values(IntegrityState)) {
      expect(Object.prototype.hasOwnProperty.call(ATTRIBUTABLE_TO_CALLER, state)).toBe(true);
    }
  });

  it("carries SEC-0.2's context through without reinterpreting it", () => {
    const result = assessIntegrity(
      annotation({ status: "INTEGRITY_REPLAYED", detail: "different_request", cached: true })
    );

    expect(result.source).toBe("INTEGRITY_REPLAYED");
    expect(result.reason).toBe("different_request");
    expect(result.cached).toBe(true);
    expect(result.tokenDigest).toBe("abc123def456");
    expect(result.endpoint).toBe("POST /api/wallet/reward");
  });
});

describe("non-OK statuses resolve without reading a verdict", () => {
  it.each([
    ["INTEGRITY_ABSENT", IntegrityState.MISSING],
    ["INTEGRITY_MALFORMED", IntegrityState.TAMPERED_REQUEST],
    ["INTEGRITY_STALE", IntegrityState.TAMPERED_REQUEST],
    ["INTEGRITY_REQUEST_MISMATCH", IntegrityState.TAMPERED_REQUEST],
    ["INTEGRITY_PACKAGE_MISMATCH", IntegrityState.MODIFIED_APP],
    ["INTEGRITY_REPLAYED", IntegrityState.REPLAYED],
    ["INTEGRITY_DECODE_FAILED", IntegrityState.TAMPERED_REQUEST],
    ["INTEGRITY_DECODE_UNAVAILABLE", IntegrityState.INDETERMINATE],
  ])("%s → %s", (status, expected) => {
    expect(assessIntegrity(annotation({ status, verdict: null })).state).toBe(expected);
  });

  it("keeps a Google outage unattributable and a mismatch attributable", () => {
    // SEC-0.2's central distinction has to survive interpretation, or SEC-0.5
    // is forced to choose between failing open on attacks and failing closed
    // during an outage.
    expect(assessIntegrity(annotation({ status: "INTEGRITY_DECODE_UNAVAILABLE" })).attributableToCaller).toBe(false);
    expect(assessIntegrity(annotation({ status: "INTEGRITY_REQUEST_MISMATCH" })).attributableToCaller).toBe(true);
  });

  it("leaves MISSING deliberately ambiguous", () => {
    // A stripped header and a device with broken Play Services are
    // indistinguishable here. Pretending otherwise would be policy.
    expect(assessIntegrity(annotation({ status: "INTEGRITY_ABSENT" })).attributableToCaller).toBeNull();
  });
});

describe("app recognition", () => {
  it("PLAY_RECOGNIZED on a certified device is the only TRUSTED path", () => {
    const r = assessIntegrity(annotation({ verdict: verdict() }));

    expect(r.state).toBe(IntegrityState.TRUSTED);
    expect(r.app).toBe(AppState.RECOGNIZED);
    expect(r.device).toBe(DeviceState.CERTIFIED);
    expect(r.licensing).toBe(LicensingState.LICENSED);
    expect(r.attributableToCaller).toBe(false);
  });

  it("UNRECOGNIZED_VERSION is a modified application, not a rejection", () => {
    const r = assessIntegrity(annotation({ verdict: verdict({ app: "UNRECOGNIZED_VERSION" }) }));

    expect(r.state).toBe(IntegrityState.MODIFIED_APP);
    expect(r.app).toBe(AppState.MODIFIED);
  });

  it("UNEVALUATED app is its own state, not a failure", () => {
    const r = assessIntegrity(annotation({ verdict: verdict({ app: "UNEVALUATED" }) }));

    expect(r.state).toBe(IntegrityState.UNEVALUATED);
  });

  it("reports a modified app even when the device is also compromised", () => {
    // The more specific and more serious finding wins; reporting
    // UNTRUSTED_DEVICE here would send SEC-0.5 after the wrong problem.
    const r = assessIntegrity(annotation({ verdict: verdict({ app: "UNRECOGNIZED_VERSION", device: [] }) }));

    expect(r.state).toBe(IntegrityState.MODIFIED_APP);
  });
});

describe("device recognition", () => {
  it("an empty verdict is COMPROMISED, not unknown", () => {
    // Google documents the empty array as an affirmative signal of root, API
    // hooking, or a failing emulator. Treating it as "no information" would
    // discard the single most important negative signal.
    const r = assessIntegrity(annotation({ verdict: verdict({ device: [] }) }));

    expect(r.device).toBe(DeviceState.COMPROMISED);
    expect(r.state).toBe(IntegrityState.UNTRUSTED_DEVICE);
  });

  it("an omitted deviceIntegrity field is also COMPROMISED", () => {
    const r = assessIntegrity(annotation({ verdict: verdict({ device: null }) }));

    expect(r.device).toBe(DeviceState.COMPROMISED);
  });

  it("takes the strongest label when several are present", () => {
    const r = assessIntegrity(
      annotation({ verdict: verdict({ device: ["MEETS_BASIC_INTEGRITY", "MEETS_STRONG_INTEGRITY"] }) })
    );

    expect(r.device).toBe(DeviceState.STRONG);
    expect(r.state).toBe(IntegrityState.TRUSTED);
    expect(r.deviceLabels).toEqual(["MEETS_BASIC_INTEGRITY", "MEETS_STRONG_INTEGRITY"]);
  });

  it.each([
    [["MEETS_BASIC_INTEGRITY"], DeviceState.BASIC],
    [["MEETS_VIRTUAL_INTEGRITY"], DeviceState.VIRTUAL],
  ])("%s does not reach TRUSTED, but stays visible to SEC-0.5", (labels, expectedDevice) => {
    const r = assessIntegrity(annotation({ verdict: verdict({ device: labels }) }));

    expect(r.device).toBe(expectedDevice);
    expect(r.state).toBe(IntegrityState.UNTRUSTED_DEVICE);
    // The detail survives, so a policy that wants to accept these can - it
    // just has to say so, rather than inherit it from this table.
    expect(r.deviceLabels).toEqual(labels);
  });
});

describe("unknown future verdicts never crash and never read as trusted", () => {
  it("an unknown app verdict is INDETERMINATE", () => {
    const r = assessIntegrity(annotation({ verdict: verdict({ app: "MEETS_SOME_FUTURE_THING" }) }));

    expect(r.app).toBe(AppState.UNKNOWN);
    expect(r.state).toBe(IntegrityState.INDETERMINATE);
    expect(r.state).not.toBe(IntegrityState.TRUSTED);
  });

  it("an unknown device label is INDETERMINATE, not trusted", () => {
    const r = assessIntegrity(annotation({ verdict: verdict({ device: ["MEETS_FUTURE_INTEGRITY"] }) }));

    expect(r.device).toBe(DeviceState.UNKNOWN);
    expect(r.state).toBe(IntegrityState.INDETERMINATE);
  });

  it("an unknown licensing verdict is classified without affecting the state", () => {
    const r = assessIntegrity(annotation({ verdict: verdict({ licensing: "SOMETHING_NEW" }) }));

    expect(r.licensing).toBe(LicensingState.UNKNOWN);
    expect(r.state).toBe(IntegrityState.TRUSTED);
  });

  it("a status SEC-0.2 grows later is INDETERMINATE, not a crash", () => {
    const r = assessIntegrity(annotation({ status: "INTEGRITY_SOMETHING_NEW" }));

    expect(r.state).toBe(IntegrityState.INDETERMINATE);
    expect(r.reason).toBe("unmapped_status");
  });

  it("prototype-chain strings do not resolve to a real state", () => {
    // `map[userControlledKey]` without hasOwnProperty is the SEC-15.4 bug shape.
    for (const evil of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      const r = assessIntegrity(annotation({ verdict: verdict({ app: evil }) }));
      expect(r.app).toBe(AppState.UNKNOWN);
      expect(r.state).toBe(IntegrityState.INDETERMINATE);
    }
  });
});

describe("totality", () => {
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a string", "nonsense"],
    ["a number", 42],
    ["an empty object", {}],
    ["a non-string status", { status: 7 }],
    ["OK with no verdict", { status: "INTEGRITY_OK", verdict: null }],
    ["OK with a string verdict", { status: "INTEGRITY_OK", verdict: "nope" }],
    ["OK with an empty verdict", { status: "INTEGRITY_OK", verdict: {} }],
    ["device labels that are not strings", { status: "INTEGRITY_OK", verdict: { deviceIntegrity: { deviceRecognitionVerdict: [1, null, {}] } } }],
  ])("%s never throws and never yields TRUSTED", (_label, input) => {
    let result;
    expect(() => {
      result = assessIntegrity(input);
    }).not.toThrow();

    expect(Object.values(IntegrityState)).toContain(result.state);
    expect(result.state).not.toBe(IntegrityState.TRUSTED);
  });

  it("a missing annotation is INDETERMINATE, never MISSING", () => {
    // MISSING means "we looked for a token and found none". If SEC-0.2 never
    // ran, we did not look - claiming otherwise would misreport our own gap as
    // the caller's behaviour.
    const r = assessIntegrity(undefined);

    expect(r.state).toBe(IntegrityState.INDETERMINATE);
    expect(r.reason).toBe("no_integrity_annotation");
  });

  it("is pure: the same input always gives the same output", () => {
    const input = annotation({ verdict: verdict() });

    expect(assessIntegrity(input)).toEqual(assessIntegrity(input));
  });

  it("does not mutate its input", () => {
    const input = annotation({ verdict: verdict() });
    const snapshot = JSON.parse(JSON.stringify(input));

    assessIntegrity(input);

    expect(input).toEqual(snapshot);
  });
});

describe("it contains no policy", () => {
  it("never produces an allow/deny signal", () => {
    const r = assessIntegrity(annotation({ verdict: verdict({ app: "UNRECOGNIZED_VERSION" }) }));

    // The vocabulary is descriptive only. If a key like `allowed`, `deny` or
    // `statusCode` ever appears here, enforcement has leaked into
    // classification and SEC-0.5 has lost its single point of control.
    expect(Object.keys(r).sort()).toEqual(
      [
        "app",
        "attributableToCaller",
        "cached",
        "device",
        "deviceLabels",
        "endpoint",
        "licensing",
        "reason",
        "source",
        "state",
        "tokenDigest",
      ].sort()
    );
  });
});
