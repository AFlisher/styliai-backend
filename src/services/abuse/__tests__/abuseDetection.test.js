jest.mock("../detectors", () => ({
  registrationVelocity: jest.fn().mockResolvedValue([]),
  generationVelocity: jest.fn().mockResolvedValue([]),
  rewardFarmingByOrigin: jest.fn().mockResolvedValue([]),
  adminAdjustmentVolume: jest.fn().mockResolvedValue(null),
  concurrentSessionOrigins: jest.fn().mockResolvedValue([]),
  riskSignalsForUsers: jest.fn().mockResolvedValue([]),
}));
jest.mock("../../../models/abuseFindingModel", () => ({
  record: jest.fn(async (f) => ({ id: "finding-1", ...f })),
  setAction: jest.fn().mockResolvedValue({ id: "finding-1", action: "suspended" }),
  upsertRiskScore: jest.fn().mockResolvedValue({}),
}));
jest.mock("../enforcement", () => ({
  autoSuspend: jest.fn().mockResolvedValue({ suspended: true, reason: "suspended" }),
  shouldAutoSuspend: jest.requireActual("../enforcement").shouldAutoSuspend,
}));

const detectors = require("../detectors");
const findings = require("../../../models/abuseFindingModel");
const enforcement = require("../enforcement");
const { runSweep, maybeSweep, resetSweepState } = require("../abuseDetection");
const { buildPolicy } = require("../../../config/abusePolicy");

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const ORIGIN = "abcdef0123456789abcdef0123456789";

/** A policy with enforcement ON, for the tests that exercise it. */
const enforcingPolicy = () =>
  buildPolicy({ ABUSE_AUTO_SUSPEND: "true", ABUSE_SWEEP_ENABLED: "true" });

const quietPolicy = () => buildPolicy({ ABUSE_SWEEP_ENABLED: "true" });

beforeEach(() => {
  jest.clearAllMocks();
  resetSweepState();
  detectors.registrationVelocity.mockResolvedValue([]);
  detectors.generationVelocity.mockResolvedValue([]);
  detectors.rewardFarmingByOrigin.mockResolvedValue([]);
  detectors.adminAdjustmentVolume.mockResolvedValue(null);
  detectors.concurrentSessionOrigins.mockResolvedValue([]);
  detectors.riskSignalsForUsers.mockResolvedValue([]);
  findings.record.mockImplementation(async (f) => ({ id: "finding-1", ...f }));
  enforcement.autoSuspend.mockResolvedValue({ suspended: true, reason: "suspended" });
});

// ---------------------------------------------------------------------------
// Normal behaviour
// ---------------------------------------------------------------------------

describe("SEC-18.1 — a quiet system produces no findings", () => {
  // The single most important false-positive test: with nothing anomalous in
  // the data, the sweep must record NOTHING. A detector that fires on an idle
  // system is a detector that will be ignored within a week.
  it("records no findings and suspends nobody when every detector is empty", async () => {
    const summary = await runSweep({ policy: quietPolicy() });

    expect(findings.record).not.toHaveBeenCalled();
    expect(enforcement.autoSuspend).not.toHaveBeenCalled();
    expect(summary.suspended).toBe(0);
    expect(summary.errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Each detector actually detects (VACUITY)
// ---------------------------------------------------------------------------

describe("SEC-18.1 — VACUITY: every detector proves it detects something", () => {
  it("registration velocity produces an origin-scoped finding", async () => {
    detectors.registrationVelocity.mockResolvedValue([
      { originHash: ORIGIN, accountCount: 9, countryCount: 1, userIds: [USER_A, USER_B] },
    ]);

    await runSweep({ policy: quietPolicy() });

    expect(findings.record).toHaveBeenCalledWith(
      expect.objectContaining({
        detector: "registration_velocity",
        originHash: ORIGIN,
        userId: null, // implicates a GROUP, never one account
        evidence: expect.objectContaining({ accountCount: 9 }),
      })
    );
  });

  it("generation velocity produces a user-scoped finding", async () => {
    detectors.generationVelocity.mockResolvedValue([
      { userId: USER_A, generationCount: 44, originHash: ORIGIN },
    ]);

    await runSweep({ policy: quietPolicy() });

    expect(findings.record).toHaveBeenCalledWith(
      expect.objectContaining({
        detector: "generation_velocity",
        userId: USER_A,
        evidence: expect.objectContaining({ generationCount: 44 }),
      })
    );
  });

  it("reward farming produces an origin-scoped finding", async () => {
    detectors.rewardFarmingByOrigin.mockResolvedValue([
      { originHash: ORIGIN, accountCount: 14, creditsClaimed: 14 },
    ]);

    await runSweep({ policy: quietPolicy() });

    expect(findings.record).toHaveBeenCalledWith(
      expect.objectContaining({
        detector: "reward_farming_origin",
        evidence: expect.objectContaining({ accountCount: 14, creditsClaimed: 14 }),
      })
    );
  });

  it("admin adjustment volume produces a finding", async () => {
    detectors.adminAdjustmentVolume.mockResolvedValue({
      adjustmentCount: 40, affectedUsers: 12, creditsGranted: 900,
    });

    await runSweep({ policy: quietPolicy() });

    expect(findings.record).toHaveBeenCalledWith(
      expect.objectContaining({ detector: "admin_adjustment_volume" })
    );
  });

  it("concurrent session origins produces a finding (SEC-18.5)", async () => {
    detectors.concurrentSessionOrigins.mockResolvedValue([
      { userId: USER_A, originCount: 4, sessionCount: 6, deviceKinds: 2 },
    ]);

    await runSweep({ policy: quietPolicy() });

    expect(findings.record).toHaveBeenCalledWith(
      expect.objectContaining({
        detector: "concurrent_session_origins",
        userId: USER_A,
        evidence: expect.objectContaining({ originCount: 4 }),
      })
    );
  });
});

// ---------------------------------------------------------------------------
// Severity ladder
// ---------------------------------------------------------------------------

describe("SEC-18.1 — severity distinguishes 'unusual' from 'unambiguous'", () => {
  it("is medium just over the threshold and high past the high threshold", async () => {
    const policy = quietPolicy();

    detectors.generationVelocity.mockResolvedValue([
      { userId: USER_A, generationCount: policy.generation.perUserThreshold, originHash: null },
    ]);
    await runSweep({ policy });
    expect(findings.record).toHaveBeenCalledWith(
      expect.objectContaining({ severity: "medium" })
    );

    jest.clearAllMocks();
    findings.record.mockImplementation(async (f) => ({ id: "f", ...f }));
    detectors.registrationVelocity.mockResolvedValue([]);
    detectors.rewardFarmingByOrigin.mockResolvedValue([]);
    detectors.adminAdjustmentVolume.mockResolvedValue(null);
    detectors.concurrentSessionOrigins.mockResolvedValue([]);
    detectors.riskSignalsForUsers.mockResolvedValue([]);
    detectors.generationVelocity.mockResolvedValue([
      { userId: USER_A, generationCount: policy.generation.perUserHighThreshold, originHash: null },
    ]);
    await runSweep({ policy });
    expect(findings.record).toHaveBeenCalledWith(
      expect.objectContaining({ severity: "high" })
    );
  });

  it("admin adjustment volume is NEVER high — it reports a rate, not a verdict", async () => {
    detectors.adminAdjustmentVolume.mockResolvedValue({
      adjustmentCount: 100000, affectedUsers: 5000, creditsGranted: 999999,
    });
    await runSweep({ policy: quietPolicy() });
    expect(findings.record).toHaveBeenCalledWith(
      expect.objectContaining({ detector: "admin_adjustment_volume", severity: "medium" })
    );
  });
});

// ---------------------------------------------------------------------------
// Enforcement (SEC-18.2)
// ---------------------------------------------------------------------------

describe("SEC-18.2 — automatic enforcement is off by default", () => {
  // The single most consequential default in the phase. A false positive locks
  // a real user out of an account they watched ads to fund.
  it("does not suspend even a high-severity finding with the default policy", async () => {
    detectors.generationVelocity.mockResolvedValue([
      { userId: USER_A, generationCount: 100000, originHash: null },
    ]);

    await runSweep({ policy: quietPolicy() });

    // The finding IS recorded - detection still happens - but nothing acts on
    // it. `action` is not passed explicitly here; it defaults to 'flagged' in
    // both the model signature and the column default, so the assertion is on
    // the behaviour (nobody was suspended, no action was stamped) rather than
    // on a field the sweep deliberately leaves to its default.
    expect(findings.record).toHaveBeenCalledWith(
      expect.objectContaining({ detector: "generation_velocity", severity: "high" })
    );
    expect(enforcement.autoSuspend).not.toHaveBeenCalled();
    expect(findings.setAction).not.toHaveBeenCalled();
  });
});

describe("SEC-18.2 — when enabled, enforcement is narrow", () => {
  it("suspends a high-severity user-scoped finding", async () => {
    const policy = enforcingPolicy();
    detectors.generationVelocity.mockResolvedValue([
      { userId: USER_A, generationCount: policy.generation.perUserHighThreshold + 5, originHash: null },
    ]);

    const summary = await runSweep({ policy });

    expect(enforcement.autoSuspend).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_A, detector: "generation_velocity" })
    );
    expect(findings.setAction).toHaveBeenCalledWith("finding-1", "suspended");
    expect(summary.suspended).toBe(1);
  });

  it("does NOT suspend a medium-severity finding", async () => {
    const policy = enforcingPolicy();
    detectors.generationVelocity.mockResolvedValue([
      { userId: USER_A, generationCount: policy.generation.perUserThreshold, originHash: null },
    ]);

    await runSweep({ policy });

    expect(enforcement.autoSuspend).not.toHaveBeenCalled();
  });

  // The most important safety property in the phase: origin-scoped detectors
  // implicate EVERYONE behind a shared address (carrier-grade NAT, a campus, an
  // office). Acting on them automatically would suspend bystanders.
  it("NEVER auto-suspends on an origin-scoped detector, even at high severity", async () => {
    const policy = enforcingPolicy();
    detectors.registrationVelocity.mockResolvedValue([
      { originHash: ORIGIN, accountCount: 9999, countryCount: 1, userIds: [USER_A] },
    ]);
    detectors.rewardFarmingByOrigin.mockResolvedValue([
      { originHash: ORIGIN, accountCount: 9999, creditsClaimed: 9999 },
    ]);

    await runSweep({ policy });

    expect(enforcement.autoSuspend).not.toHaveBeenCalled();
  });

  it("records the finding BEFORE acting, so nothing is suspended without a reason on file", async () => {
    const policy = enforcingPolicy();
    const order = [];
    findings.record.mockImplementation(async (f) => {
      order.push("record");
      return { id: "finding-1", ...f };
    });
    enforcement.autoSuspend.mockImplementation(async () => {
      order.push("suspend");
      return { suspended: true, reason: "suspended" };
    });
    detectors.generationVelocity.mockResolvedValue([
      { userId: USER_A, generationCount: 100000, originHash: null },
    ]);

    await runSweep({ policy });

    expect(order).toEqual(["record", "suspend"]);
  });

  it("leaves the finding flagged when enforcement declines or fails", async () => {
    const policy = enforcingPolicy();
    enforcement.autoSuspend.mockResolvedValue({ suspended: false, reason: "error" });
    detectors.generationVelocity.mockResolvedValue([
      { userId: USER_A, generationCount: 100000, originHash: null },
    ]);

    const summary = await runSweep({ policy });

    expect(findings.setAction).not.toHaveBeenCalled();
    expect(summary.suspended).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Resilience
// ---------------------------------------------------------------------------

describe("SEC-18.1 — one broken detector does not take down the others", () => {
  it("continues after a detector throws and reports the error", async () => {
    detectors.registrationVelocity.mockRejectedValue(new Error("bad query"));
    detectors.generationVelocity.mockResolvedValue([
      { userId: USER_A, generationCount: 44, originHash: null },
    ]);

    const summary = await runSweep({ policy: quietPolicy() });

    expect(summary.errors).toEqual([
      expect.objectContaining({ detector: "registration_velocity" }),
    ]);
    expect(summary.generationVelocity).toBe(1);
  });

  it("never rejects, whatever the detectors do", async () => {
    detectors.registrationVelocity.mockRejectedValue(new Error("a"));
    detectors.generationVelocity.mockRejectedValue(new Error("b"));
    detectors.rewardFarmingByOrigin.mockRejectedValue(new Error("c"));
    detectors.adminAdjustmentVolume.mockRejectedValue(new Error("d"));
    detectors.concurrentSessionOrigins.mockRejectedValue(new Error("e"));

    await expect(runSweep({ policy: quietPolicy() })).resolves.toBeDefined();
  });

  it("does not leak a raw error object into the summary", async () => {
    detectors.generationVelocity.mockRejectedValue(
      Object.assign(new Error("x".repeat(1000)), { secret: "hunter2" })
    );
    const summary = await runSweep({ policy: quietPolicy() });
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("hunter2");
    expect(summary.errors[0].error.length).toBeLessThanOrEqual(300);
  });
});

// ---------------------------------------------------------------------------
// Concurrency / scheduling
// ---------------------------------------------------------------------------

describe("SEC-18.1 — the opportunistic trigger", () => {
  it("is disabled under the test policy by default", () => {
    expect(maybeSweep({ policy: buildPolicy({ NODE_ENV: "test" }) })).toBe(false);
  });

  it("starts at most ONE sweep for a burst of concurrent requests", () => {
    const policy = quietPolicy();
    const started = [
      maybeSweep({ policy }),
      maybeSweep({ policy }),
      maybeSweep({ policy }),
      maybeSweep({ policy }),
    ];
    expect(started.filter(Boolean)).toHaveLength(1);
  });

  it("respects the interval between sweeps", () => {
    const policy = quietPolicy();
    const t0 = 1_000_000;
    expect(maybeSweep({ now: t0, policy })).toBe(true);
    resetSweepState();

    // Re-arm the "already swept" state by sweeping at t0, then try again a
    // moment later: the interval gate, not the in-flight gate, must refuse it.
    expect(maybeSweep({ now: t0, policy })).toBe(true);
    expect(maybeSweep({ now: t0 + 1000, policy })).toBe(false);
    expect(maybeSweep({ now: t0 + policy.sweepIntervalMs + 1, policy })).toBe(false); // still in flight
  });

  it("never throws into the caller", () => {
    detectors.registrationVelocity.mockRejectedValue(new Error("boom"));
    expect(() => maybeSweep({ policy: quietPolicy() })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Risk scoring integration
// ---------------------------------------------------------------------------

describe("SEC-18.1 — risk scores are computed only for implicated accounts", () => {
  it("scores accounts a detector touched", async () => {
    detectors.generationVelocity.mockResolvedValue([
      { userId: USER_A, generationCount: 44, originHash: null },
    ]);
    detectors.riskSignalsForUsers.mockResolvedValue([
      { userId: USER_A, accountCreatedAt: new Date().toISOString(), emailVerified: false,
        provider: "email", status: "active", generations: 44, rewards: 1, originSiblings: 9 },
    ]);

    await runSweep({ policy: quietPolicy() });

    expect(detectors.riskSignalsForUsers).toHaveBeenCalledWith([USER_A]);
    expect(findings.upsertRiskScore).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_A, score: expect.any(Number) })
    );
  });

  it("does not score anyone when nothing fired", async () => {
    await runSweep({ policy: quietPolicy() });
    expect(detectors.riskSignalsForUsers).not.toHaveBeenCalled();
    expect(findings.upsertRiskScore).not.toHaveBeenCalled();
  });
});
