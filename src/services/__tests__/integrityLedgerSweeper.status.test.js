// System Health module: getStatus() exposes the sweeper's existing in-memory
// state read-only, so the dashboard can show "when did this last run"
// without changing the sweep's own behavior. Kept in its own file rather
// than added to integrityLedgerSweeper.test.js so the two suites' module
// state (both use the same singleton sweeper) never interact by accident.

process.env.PLAY_INTEGRITY_SWEEP_INTERVAL_MS = "10000";

jest.mock("../../models/integrityVerdictModel");

const integrityVerdictModel = require("../../models/integrityVerdictModel");
const sweeper = require("../integrityLedgerSweeper");

beforeEach(() => {
  jest.clearAllMocks();
  sweeper.resetForTest();
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  console.log.mockRestore();
  console.error.mockRestore();
});

describe("getStatus", () => {
  it("reports lastSweepAt as null and sweeping false before any sweep has run", () => {
    expect(sweeper.getStatus()).toEqual({ lastSweepAt: null, sweeping: false });
  });

  it("reports sweeping true while a sweep is in flight", () => {
    integrityVerdictModel.evict.mockReturnValue(new Promise(() => {})); // never settles

    sweeper.maybeSweep();

    expect(sweeper.getStatus().sweeping).toBe(true);
    expect(sweeper.getStatus().lastSweepAt).not.toBeNull();
  });

  it("reports sweeping false and a real ISO timestamp once a sweep completes", async () => {
    integrityVerdictModel.evict.mockResolvedValue({ verdictsDropped: 1, rowsDeleted: 1 });

    sweeper.maybeSweep();
    await new Promise((r) => setImmediate(r));

    const status = sweeper.getStatus();
    expect(status.sweeping).toBe(false);
    expect(() => new Date(status.lastSweepAt).toISOString()).not.toThrow();
    expect(new Date(status.lastSweepAt).toISOString()).toBe(status.lastSweepAt);
  });
});
