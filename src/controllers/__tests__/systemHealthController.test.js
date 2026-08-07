// System Health module controller: composition over many existing sources.
// The behavior that matters most here is graceful degradation - this
// endpoint is what an operator looks at when something is wrong, so one
// failing dependency (most importantly the database) must produce a
// `status: "down"` SECTION, never a failed response.

jest.mock("../../config/db", () => ({
  query: jest.fn(),
  pool: { totalCount: 3, idleCount: 2, waitingCount: 0 },
}));
jest.mock("../../services/storageUsageService", () => ({ getStorageUsage: jest.fn() }));
jest.mock("../../models/systemIncidentModel", () => ({ list: jest.fn() }));
jest.mock("../../models/backupRunModel", () => ({ latest: jest.fn(), list: jest.fn() }));
jest.mock("../../services/integrityLedgerSweeper", () => ({ getStatus: jest.fn() }));
jest.mock("../../services/abuse/abuseDetection", () => ({ getSweepStatus: jest.fn() }));
jest.mock("../../utils/metrics", () => ({ snapshot: jest.fn() }));

const db = require("../../config/db");
const storageUsageService = require("../../services/storageUsageService");
const systemIncidentModel = require("../../models/systemIncidentModel");
const backupRunModel = require("../../models/backupRunModel");
const integrityLedgerSweeper = require("../../services/integrityLedgerSweeper");
const abuseDetection = require("../../services/abuse/abuseDetection");
const metrics = require("../../utils/metrics");
const { getSystemHealth, listIncidents } = require("../systemHealthController");

function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn(), set: jest.fn() };
}

function healthyDefaults() {
  db.query.mockImplementation((sql) => {
    if (sql.includes("schema_migrations")) {
      return Promise.resolve({
        rows: [{ filename: "migration_x.sql", appliedAt: "2026-01-01T00:00:00.000Z", lastRunAt: "2026-01-01T00:00:00.000Z", runCount: 1, durationMs: 12 }],
      });
    }
    return Promise.resolve({ rows: [{ "?column?": 1 }] }); // SELECT 1
  });
  storageUsageService.getStorageUsage.mockResolvedValue({
    megabytes: 120.5, objectCount: 40, truncated: false, asOf: "2026-01-01T00:00:00.000Z", cached: true,
  });
  systemIncidentModel.list.mockResolvedValue({ rows: [], total: 0 });
  backupRunModel.latest.mockResolvedValue({ id: "run-1", status: "success", createdAt: "2026-01-01T00:00:00.000Z" });
  backupRunModel.list.mockResolvedValue({ rows: [], total: 0 });
  integrityLedgerSweeper.getStatus.mockReturnValue({ lastSweepAt: "2026-01-01T00:00:00.000Z", sweeping: false });
  abuseDetection.getSweepStatus.mockReturnValue({ lastSweepAt: null, sweeping: false });
  metrics.snapshot.mockReturnValue({ requests: { total: 10, byStatusClass: { "2xx": 10 }, errorRate: 0, serverErrorRate: 0 } });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
  healthyDefaults();
  delete process.env.RESEND_API_KEY;
  delete process.env.RAILWAY_GIT_COMMIT_SHA;
});

afterEach(() => {
  console.error.mockRestore();
});

describe("getSystemHealth - the happy path", () => {
  it("returns ok for every section and an overall ok status", async () => {
    process.env.RESEND_API_KEY = "re_live_test_key";
    const res = makeRes();
    await getSystemHealth({}, res);

    const payload = res.json.mock.calls[0][0];
    expect(payload.status).toBe("ok");
    expect(payload.database.status).toBe("ok");
    expect(payload.database.pool).toEqual({ total: 3, idle: 2, waiting: 0 });
    expect(payload.storage.status).toBe("ok");
    expect(payload.storage.megabytes).toBe(120.5);
    expect(payload.imageProvider.status).toBe("ok");
    expect(payload.queue).toEqual({
      available: false,
      status: "not_applicable",
      note: expect.stringContaining("No job queue exists"),
    });
    expect(payload.lastMigration.filename).toBe("migration_x.sql");
    expect(payload.lastBackup.database.status).toBe("success");
    expect(res.set).toHaveBeenCalledWith("Cache-Control", "no-store");
  });

  it("reports scheduledJobs from both sweepers' live status", async () => {
    const res = makeRes();
    await getSystemHealth({}, res);

    const jobs = res.json.mock.calls[0][0].scheduledJobs;
    expect(jobs).toHaveLength(2);
    expect(jobs.find((j) => j.name === "abuse_detection_sweep")).toMatchObject({ lastSweepAt: null, sweeping: false });
    expect(jobs.find((j) => j.name === "integrity_ledger_sweep")).toMatchObject({ sweeping: false });
  });

  it("never exposes a raw email API key, only configured:boolean", async () => {
    process.env.RESEND_API_KEY = "re_live_SENTINEL";
    const res = makeRes();

    await getSystemHealth({}, res);

    expect(JSON.stringify(res.json.mock.calls[0][0])).not.toContain("SENTINEL");
    expect(res.json.mock.calls[0][0].email.configured).toBe(true);
  });

  it("reports email as degraded (simulated) when no key is configured", async () => {
    const res = makeRes();
    await getSystemHealth({}, res);

    expect(res.json.mock.calls[0][0].email).toMatchObject({ status: "degraded", configured: false });
  });
});

describe("getSystemHealth - graceful degradation", () => {
  it("marks the database section down without failing the whole response, when Postgres is unreachable", async () => {
    db.query.mockRejectedValue(new Error("connection terminated"));
    const res = makeRes();

    await getSystemHealth({}, res);

    expect(res.status).not.toHaveBeenCalledWith(500);
    const payload = res.json.mock.calls[0][0];
    expect(payload.database.status).toBe("down");
    expect(payload.database.error).toBe("connection terminated");
    expect(payload.status).toBe("down");
    // Sections that don't depend on Postgres still report normally.
    expect(payload.storage.status).toBe("ok");
  });

  it("marks storage down when getStorageUsage reports unavailable", async () => {
    storageUsageService.getStorageUsage.mockResolvedValue({ unavailable: true, megabytes: null, objectCount: null });
    const res = makeRes();

    await getSystemHealth({}, res);

    expect(res.json.mock.calls[0][0].storage.status).toBe("down");
  });

  it("marks storage degraded (not down) when serving a stale cached figure", async () => {
    storageUsageService.getStorageUsage.mockResolvedValue({ megabytes: 10, objectCount: 1, cached: true, stale: true });
    const res = makeRes();

    await getSystemHealth({}, res);

    expect(res.json.mock.calls[0][0].storage.status).toBe("degraded");
  });

  it("degrades gracefully even if storageUsageService unexpectedly throws", async () => {
    storageUsageService.getStorageUsage.mockRejectedValue(new Error("boom"));
    const res = makeRes();

    await getSystemHealth({}, res);

    expect(res.status).not.toHaveBeenCalledWith(500);
    expect(res.json.mock.calls[0][0].storage.status).toBe("down");
  });

  it("degrades the imageProvider section without failing the response when the incident query fails", async () => {
    systemIncidentModel.list.mockRejectedValue(new Error("db down"));
    const res = makeRes();

    await getSystemHealth({}, res);

    expect(res.status).not.toHaveBeenCalledWith(500);
    expect(res.json.mock.calls[0][0].imageProvider.status).toBe("down");
  });

  it("degrades imageProvider status when incident volume crosses the threshold", async () => {
    systemIncidentModel.list.mockResolvedValue({ rows: [{ createdAt: "2026-01-01T00:00:00.000Z" }], total: 25 });
    const res = makeRes();

    await getSystemHealth({}, res);

    expect(res.json.mock.calls[0][0].imageProvider.status).toBe("degraded");
  });

  it("degrades lastMigration/lastBackup to a null+error shape rather than 500ing when their queries fail", async () => {
    backupRunModel.latest.mockRejectedValue(new Error("pool exhausted"));
    const res = makeRes();

    await getSystemHealth({}, res);

    expect(res.status).not.toHaveBeenCalledWith(500);
    const payload = res.json.mock.calls[0][0];
    expect(payload.lastBackup).toEqual({ database: null, storage: null });
    expect(payload.backupsError).toBe("pool exhausted");
  });

  it("answers 500 for a genuinely unexpected failure outside every guarded section", async () => {
    // Every per-dependency check below is individually try/caught; this
    // simulates the one thing that isn't - a bug in the aggregation code
    // itself, exercised here via metrics.snapshot() throwing.
    metrics.snapshot.mockImplementation(() => {
      throw new Error("metrics exploded");
    });
    const res = makeRes();

    await getSystemHealth({}, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ message: "Internal server error." });
  });
});

describe("listIncidents", () => {
  it("defaults to no filter and passes limit/offset through", async () => {
    systemIncidentModel.list.mockResolvedValue({ rows: [{ id: "i-1" }], total: 1 });
    const res = makeRes();

    await listIncidents({ query: {} }, res);

    expect(systemIncidentModel.list).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 50, offset: 0, source: "all", severity: "all" })
    );
    expect(res.json).toHaveBeenCalledWith({ incidents: [{ id: "i-1" }], total: 1, limit: 50, offset: 0 });
  });

  it("rejects an unrecognized source with 400 before querying", async () => {
    const res = makeRes();

    await listIncidents({ query: { source: "database" } }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(systemIncidentModel.list).not.toHaveBeenCalled();
  });

  it("rejects an unrecognized severity with 400 before querying", async () => {
    const res = makeRes();

    await listIncidents({ query: { severity: "critical" } }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(systemIncidentModel.list).not.toHaveBeenCalled();
  });

  it("accepts image_provider/warning/error and the 'all' sentinels", async () => {
    systemIncidentModel.list.mockResolvedValue({ rows: [], total: 0 });
    for (const [source, severity] of [["all", "all"], ["image_provider", "error"], ["image_provider", "warning"]]) {
      const res = makeRes();
      await listIncidents({ query: { source, severity } }, res);
      expect(res.status).not.toHaveBeenCalledWith(400);
    }
  });

  it("answers 500 rather than crashing when the model rejects", async () => {
    systemIncidentModel.list.mockRejectedValue(new Error("db down"));
    const res = makeRes();

    await listIncidents({ query: {} }, res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});
