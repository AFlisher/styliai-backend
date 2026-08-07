// System Health module: getSweepStatus() exposes the abuse sweeper's
// existing in-memory state read-only. Kept in its own file rather than added
// to abuseDetection.test.js so the two suites' module state (same singleton
// sweeper) never interact by accident - same reasoning as
// integrityLedgerSweeper.status.test.js.

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

const { maybeSweep, resetSweepState, getSweepStatus } = require("../abuseDetection");
const { buildPolicy } = require("../../../config/abusePolicy");

const enabledPolicy = () => buildPolicy({ ABUSE_SWEEP_ENABLED: "true" });

beforeEach(() => {
  jest.clearAllMocks();
  resetSweepState();
});

describe("getSweepStatus", () => {
  it("reports lastSweepAt as null and sweeping false before any sweep has run", () => {
    expect(getSweepStatus()).toEqual({ lastSweepAt: null, sweeping: false });
  });

  it("does not change when maybeSweep is gated off (sweeping disabled)", () => {
    maybeSweep({ policy: buildPolicy({ ABUSE_SWEEP_ENABLED: "false" }) });

    expect(getSweepStatus()).toEqual({ lastSweepAt: null, sweeping: false });
  });

  it("reports a real ISO timestamp once a sweep starts, and settles sweeping back to false", async () => {
    const started = maybeSweep({ policy: enabledPolicy() });
    expect(started).toBe(true);

    const midFlight = getSweepStatus();
    expect(midFlight.sweeping).toBe(true);
    expect(() => new Date(midFlight.lastSweepAt).toISOString()).not.toThrow();

    // Let the fire-and-forget sweep's promise chain settle.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(getSweepStatus().sweeping).toBe(false);
  });
});
