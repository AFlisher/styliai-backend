// SEC-0.5 — enforcement.
//
// The properties under test are the ones that decide whether this control is
// safe to switch on: that only HARD_FAIL blocks, that the three
// not-the-caller's-fault states never do, that a global or endpoint ceiling can
// always override the tables downward, and that a blocked response never tells
// the caller which check failed.

process.env.PLAY_INTEGRITY_ENFORCEMENT = "enforce";
process.env.PLAY_INTEGRITY_PACKAGE_NAME = "com.prombt.prombt_app";

const { IntegrityState } = require("../../services/integrityAssessment");
const {
  EnforcementAction,
  STATE_ACTIONS,
  ENDPOINT_CEILINGS,
  resolveAction,
  weakest,
  __testing: policyTesting,
} = require("../../config/integrityPolicy");

function assessment(overrides = {}) {
  return {
    state: IntegrityState.TRUSTED,
    app: "RECOGNIZED",
    device: "CERTIFIED",
    licensing: "LICENSED",
    deviceLabels: ["MEETS_DEVICE_INTEGRITY"],
    attributableToCaller: false,
    source: "INTEGRITY_OK",
    endpoint: "POST /api/generate",
    tokenDigest: "a".repeat(12),
    cached: false,
    reason: null,
    ...overrides,
  };
}

/** Runs the middleware, resolving to { blocked, error, req }. */
function run(req, enforce) {
  jest.resetModules();
  process.env.PLAY_INTEGRITY_ENFORCEMENT = enforce || "enforce";
  const middleware = require("../enforceIntegrity");
  return new Promise((resolve) => {
    const res = new Proxy(
      {},
      {
        get(_t, prop) {
          throw new Error(`enforceIntegrity touched res.${String(prop)} - it must use next(err)`);
        },
      }
    );
    middleware(req, res, (err) =>
      resolve({ blocked: Boolean(err), error: err, req })
    );
  });
}

beforeEach(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  console.log.mockRestore();
  console.warn.mockRestore();
  console.error.mockRestore();
});

describe("what blocks and what does not", () => {
  it.each([
    [IntegrityState.TRUSTED, false],
    [IntegrityState.MODIFIED_APP, true],
    [IntegrityState.TAMPERED_REQUEST, true],
    [IntegrityState.REPLAYED, true],
    [IntegrityState.UNTRUSTED_DEVICE, false], // soft_fail: degraded, not denied
    [IntegrityState.MISSING, false],
    [IntegrityState.UNEVALUATED, false],
    [IntegrityState.INDETERMINATE, false],
  ])("%s on a hard_fail endpoint → blocked=%s", async (state, expected) => {
    const { blocked } = await run({ integrityAssessment: assessment({ state }) });

    expect(blocked).toBe(expected);
  });

  it("never denies for a state that is not the caller's fault", async () => {
    // INDETERMINATE is a Google outage or an exhausted quota. Denying here
    // turns someone else's incident into ours.
    for (const state of [
      IntegrityState.INDETERMINATE,
      IntegrityState.MISSING,
      IntegrityState.UNEVALUATED,
    ]) {
      const { blocked, req } = await run({ integrityAssessment: assessment({ state }) });
      expect(blocked).toBe(false);
      expect(req.integrityPolicy.blocked).toBe(false);
    }
  });

  it("marks UNTRUSTED_DEVICE degraded without refusing it", async () => {
    const { blocked, req } = await run({
      integrityAssessment: assessment({ state: IntegrityState.UNTRUSTED_DEVICE }),
    });

    expect(blocked).toBe(false);
    expect(req.integrityPolicy.degraded).toBe(true);
    expect(req.integrityPolicy.action).toBe(EnforcementAction.SOFT_FAIL);
  });
});

describe("staged rollout", () => {
  it("login only observes, even for a state that would block elsewhere", async () => {
    const { blocked, req } = await run({
      integrityAssessment: assessment({
        state: IntegrityState.MODIFIED_APP,
        endpoint: "POST /api/auth/login",
      }),
    });

    expect(blocked).toBe(false);
    expect(req.integrityPolicy.action).toBe(EnforcementAction.LOG);
  });

  it("the same state blocks on generation", async () => {
    const { blocked } = await run({
      integrityAssessment: assessment({
        state: IntegrityState.MODIFIED_APP,
        endpoint: "POST /api/generate",
      }),
    });

    expect(blocked).toBe(true);
  });

  it("an unlisted endpoint defaults to observation, never to denial", async () => {
    // A route wired to this middleware before anyone decided its policy must
    // not start refusing users by accident.
    const { blocked, req } = await run({
      integrityAssessment: assessment({
        state: IntegrityState.REPLAYED,
        endpoint: "POST /api/something/new",
      }),
    });

    expect(blocked).toBe(false);
    expect(req.integrityPolicy.action).toBe(EnforcementAction.LOG);
  });

  it("walks the whole ladder as the ceiling is raised", async () => {
    const ladder = [
      [EnforcementAction.LOG, false, false],
      [EnforcementAction.WARN, false, false],
      [EnforcementAction.SOFT_FAIL, false, true],
      [EnforcementAction.HARD_FAIL, true, false],
    ];

    for (const [ceiling, expectBlocked, expectDegraded] of ladder) {
      jest.resetModules();
      process.env.PLAY_INTEGRITY_POLICY_OVERRIDES = `POST /api/generate=${ceiling}`;
      const middleware = require("../enforceIntegrity");
      const req = { integrityAssessment: assessment({ state: IntegrityState.MODIFIED_APP }) };
      // eslint-disable-next-line no-await-in-loop
      const err = await new Promise((resolve) => middleware(req, {}, resolve));

      expect(Boolean(err)).toBe(expectBlocked);
      expect(req.integrityPolicy.degraded).toBe(expectDegraded);
    }
    delete process.env.PLAY_INTEGRITY_POLICY_OVERRIDES;
  });
});

describe("the global kill switch", () => {
  it("log mode caps everything at observation", async () => {
    const { blocked, req } = await run(
      { integrityAssessment: assessment({ state: IntegrityState.MODIFIED_APP }) },
      "log"
    );

    expect(blocked).toBe(false);
    expect(req.integrityPolicy.action).toBe(EnforcementAction.LOG);
  });

  it("off mode caps everything at observation", async () => {
    const { blocked } = await run(
      { integrityAssessment: assessment({ state: IntegrityState.REPLAYED }) },
      "off"
    );

    expect(blocked).toBe(false);
  });

  it("an unrecognised enforcement value fails to observation, not to denial", async () => {
    const { blocked } = await run(
      { integrityAssessment: assessment({ state: IntegrityState.REPLAYED }) },
      "ENFORCE_HARDER"
    );

    expect(blocked).toBe(false);
  });
});

describe("certificate allowlisting", () => {
  function withAllowlist(list, req) {
    jest.resetModules();
    process.env.PLAY_INTEGRITY_ENFORCEMENT = "enforce";
    process.env.PLAY_INTEGRITY_CERT_SHA256 = list;
    const middleware = require("../enforceIntegrity");
    return new Promise((resolve) => middleware(req, {}, (err) => resolve({ blocked: Boolean(err), req })));
  }

  afterEach(() => {
    delete process.env.PLAY_INTEGRITY_CERT_SHA256;
  });

  const trusted = (digests) => ({
    integrityAssessment: assessment(),
    integrity: { verdict: { appIntegrity: { certificateSha256Digest: digests } } },
  });

  it("is inert when the allowlist is empty", async () => {
    const { blocked } = await withAllowlist("", trusted(["whatever"]));

    expect(blocked).toBe(false);
  });

  it("allows a certificate on the list", async () => {
    const { blocked } = await withAllowlist("ours-aaa,ours-bbb", trusted(["ours-bbb"]));

    expect(blocked).toBe(false);
  });

  it("blocks a certificate that is not on the list", async () => {
    // A binary signed by a key we do not recognise is a modified app, whatever
    // else the verdict says about the device.
    const { blocked, req } = await withAllowlist("ours-aaa", trusted(["someone-elses"]));

    expect(blocked).toBe(true);
    expect(req.integrityPolicy.reason).toBe("certificate_not_allowlisted");
    expect(req.integrityPolicy.state).toBe(IntegrityState.MODIFIED_APP);
  });

  it("blocks when the digest is missing entirely", async () => {
    const { blocked, req } = await withAllowlist("ours-aaa", {
      integrityAssessment: assessment(),
      integrity: { verdict: { appIntegrity: {} } },
    });

    expect(blocked).toBe(true);
    expect(req.integrityPolicy.reason).toBe("certificate_absent");
  });

  it("cannot upgrade a non-trusted state into a pass", async () => {
    // The check only ever makes things worse. A REPLAYED token with a perfect
    // certificate is still replayed.
    const { blocked } = await withAllowlist("ours-aaa", {
      integrityAssessment: assessment({ state: IntegrityState.REPLAYED }),
      integrity: { verdict: { appIntegrity: { certificateSha256Digest: ["ours-aaa"] } } },
    });

    expect(blocked).toBe(true);
  });
});

describe("the blocked response is not an oracle", () => {
  it("returns the same code and message for every reason", async () => {
    const results = [];
    for (const state of [
      IntegrityState.MODIFIED_APP,
      IntegrityState.REPLAYED,
      IntegrityState.TAMPERED_REQUEST,
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const { error } = await run({ integrityAssessment: assessment({ state }) });
      results.push({ code: error.code, message: error.message, status: error.statusCode });
    }

    // Telling the caller which check failed lets them tune an attack against
    // it. The detail is in the log, where the operator can see it and the
    // attacker cannot.
    expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1);
    expect(results[0].code).toBe("INTEGRITY_BLOCKED");
    expect(results[0].status).toBe(403);
  });

  it("never mentions the state, the device or the token in the message", async () => {
    const { error } = await run({
      integrityAssessment: assessment({ state: IntegrityState.MODIFIED_APP }),
    });

    for (const leak of ["MODIFIED", "REPLAY", "TAMPER", "device", "token", "verdict"]) {
      expect(error.message.toLowerCase()).not.toContain(leak.toLowerCase());
    }
  });

  it("uses next(err) rather than writing a response itself", async () => {
    // run()'s res is a Proxy that throws on any access, so arriving at next()
    // proves the global error handler stays the single response formatter.
    await expect(
      run({ integrityAssessment: assessment({ state: IntegrityState.REPLAYED }) })
    ).resolves.toBeDefined();
  });
});

describe("totality", () => {
  it("allows and records when SEC-0.3 never ran", async () => {
    const { blocked, req } = await run({});

    expect(blocked).toBe(false);
    expect(req.integrityPolicy.reason).toBe("no_assessment");
  });

  it("an unknown future state never blocks", async () => {
    const { blocked, req } = await run({
      integrityAssessment: assessment({ state: "SOME_STATE_ADDED_LATER" }),
    });

    expect(blocked).toBe(false);
    expect(req.integrityPolicy.reason).toBe("unmapped_state");
  });

  it("a hostile assessment object is allowed, not denied", async () => {
    const { blocked } = await run({
      integrityAssessment: {
        get state() {
          throw new Error("boom");
        },
      },
    });

    expect(blocked).toBe(false);
  });
});

describe("the policy table itself", () => {
  it("assigns an action to every state SEC-0.3 can produce", () => {
    for (const state of Object.values(IntegrityState)) {
      expect(Object.prototype.hasOwnProperty.call(STATE_ACTIONS, state)).toBe(true);
    }
  });

  it("only ever weakens: no combination exceeds the global ceiling", () => {
    for (const state of Object.values(IntegrityState)) {
      for (const endpoint of Object.keys(ENDPOINT_CEILINGS)) {
        const r = resolveAction({ state, endpoint, enforcement: "log" });
        expect(r.action).toBe(EnforcementAction.LOG);
      }
    }
  });

  it("weakest() picks the gentlest rung", () => {
    expect(weakest(EnforcementAction.HARD_FAIL, EnforcementAction.LOG)).toBe(EnforcementAction.LOG);
    expect(weakest(EnforcementAction.WARN, EnforcementAction.SOFT_FAIL)).toBe(EnforcementAction.WARN);
  });

  it("ignores malformed environment overrides instead of throwing", () => {
    const parsed = policyTesting.parseOverrides(
      "POST /api/generate=hard_fail,broken,POST /api/x=nonsense,=log"
    );

    expect(parsed).toEqual({ "POST /api/generate": "hard_fail" });
  });

  it("parses a certificate allowlist tolerantly", () => {
    expect(policyTesting.parseCertificateAllowlist(" aaa , bbb ,, ")).toEqual(["aaa", "bbb"]);
    expect(policyTesting.parseCertificateAllowlist(undefined)).toEqual([]);
  });
});
