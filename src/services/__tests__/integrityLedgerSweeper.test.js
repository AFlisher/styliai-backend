// SEC-0.4 — replay-ledger retention.
//
// The properties that matter: a burst of concurrent requests starts exactly one
// sweep, the request never waits for it, and a failing sweep cannot take the
// process down. That last one is not theoretical - an unhandled rejection from
// fire-and-forget work is an uncaught exception in Node, which is how SEC-16.1's
// morgan token and SEC-15.1's response hook could each have killed the API.

process.env.PLAY_INTEGRITY_SWEEP_INTERVAL_MS = "10000";

jest.mock("../../models/integrityVerdictModel");

const integrityVerdictModel = require("../../models/integrityVerdictModel");
const sweeper = require("../integrityLedgerSweeper");

beforeEach(() => {
  jest.clearAllMocks();
  sweeper.resetForTest();
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
  integrityVerdictModel.evict.mockResolvedValue({ verdictsDropped: 0, rowsDeleted: 0 });
});

afterEach(() => {
  console.log.mockRestore();
  console.error.mockRestore();
});

describe("integrityLedgerSweeper", () => {
  it("sweeps on the first call", () => {
    expect(sweeper.maybeSweep()).toBe(true);
    expect(integrityVerdictModel.evict).toHaveBeenCalledTimes(1);
  });

  it("does not sweep again inside the interval", () => {
    sweeper.maybeSweep();
    for (let i = 0; i < 50; i += 1) sweeper.maybeSweep();

    // Without the interval gate this would be a DELETE per API call.
    expect(integrityVerdictModel.evict).toHaveBeenCalledTimes(1);
  });

  it("a concurrent burst starts exactly one sweep", async () => {
    // The gate is set synchronously, before any await, so there is no
    // interleaving window for two callers to both pass it.
    let resolveEvict;
    integrityVerdictModel.evict.mockReturnValue(
      new Promise((r) => {
        resolveEvict = r;
      })
    );

    const started = [];
    for (let i = 0; i < 20; i += 1) started.push(sweeper.maybeSweep());

    expect(started.filter(Boolean)).toHaveLength(1);
    expect(integrityVerdictModel.evict).toHaveBeenCalledTimes(1);

    resolveEvict({ verdictsDropped: 0, rowsDeleted: 0 });
    await Promise.resolve();
  });

  it("returns immediately - the request never waits for the sweep", () => {
    integrityVerdictModel.evict.mockReturnValue(new Promise(() => {})); // never settles

    const started = Date.now();
    const result = sweeper.maybeSweep();

    expect(result).toBe(true);
    expect(Date.now() - started).toBeLessThan(50);
  });

  it("a failing sweep is swallowed, never rethrown", async () => {
    integrityVerdictModel.evict.mockRejectedValue(new Error("db down"));

    expect(() => sweeper.maybeSweep()).not.toThrow();

    // Let the rejection settle. If it were unhandled this would surface as an
    // unhandledRejection rather than the console.error below.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(console.error).toHaveBeenCalled();
  });

  it("releases the in-flight flag after a failure, so retention resumes", async () => {
    integrityVerdictModel.evict.mockRejectedValue(new Error("transient"));
    sweeper.maybeSweep();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // A permanently stuck flag would silently disable retention forever - the
    // failure mode is invisible, which is the worst kind.
    sweeper.resetForTest();
    integrityVerdictModel.evict.mockResolvedValue({ verdictsDropped: 1, rowsDeleted: 2 });

    expect(sweeper.maybeSweep()).toBe(true);
  });

  it("logs a structured event only when it actually removed something", async () => {
    integrityVerdictModel.evict.mockResolvedValue({ verdictsDropped: 3, rowsDeleted: 7 });
    sweeper.maybeSweep();
    await new Promise((r) => setImmediate(r));

    const logged = console.log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("integrity_ledger_sweep");
    expect(logged).toContain('"rowsDeleted":7');

    console.log.mockClear();
    sweeper.resetForTest();
    integrityVerdictModel.evict.mockResolvedValue({ verdictsDropped: 0, rowsDeleted: 0 });
    sweeper.maybeSweep();
    await new Promise((r) => setImmediate(r));

    // A no-op sweep every hour forever would be pure log noise.
    expect(console.log).not.toHaveBeenCalled();
  });
});
