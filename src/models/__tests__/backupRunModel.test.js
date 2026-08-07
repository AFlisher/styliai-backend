// System Health module: backup_runs is what makes "last successful backup"
// answerable from the running API instead of only from a local manifest
// file. `record()` uses its own short-lived pg.Client (mirroring
// runMigration.js's CLI-script pattern) rather than the shared pool - see
// backupRunModel.js for why - so this suite mocks `pg` directly rather than
// `config/db` for the write path, and mocks `config/db` for the two read
// paths, which DO use the shared pool like every other model.

jest.mock("pg", () => ({ Client: jest.fn() }));
jest.mock("../../config/db", () => ({
  query: jest.fn(),
  buildSslConfig: jest.fn(() => false),
}));

const { Client } = require("pg");
const db = require("../../config/db");
const { record, latest, list } = require("../backupRunModel");

function makeFakeClient() {
  return { connect: jest.fn().mockResolvedValue(undefined), query: jest.fn().mockResolvedValue({ rows: [{ id: "run-1" }] }), end: jest.fn().mockResolvedValue(undefined) };
}

beforeEach(() => {
  jest.clearAllMocks();
  db.buildSslConfig.mockReturnValue(false);
});

describe("record", () => {
  it("connects a short-lived client, inserts, and always ends it", async () => {
    const client = makeFakeClient();
    Client.mockImplementation(() => client);

    await record({
      kind: "database",
      status: "success",
      bytes: 12345,
      durationMs: 900,
      detail: { sha256: "abc" },
      connectionString: "postgres://u:p@host/db",
    });

    expect(Client).toHaveBeenCalledWith({ connectionString: "postgres://u:p@host/db", ssl: false });
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenCalledTimes(1);
    const [sql, params] = client.query.mock.calls[0];
    expect(sql).toContain("INSERT INTO backup_runs");
    expect(params).toEqual(["database", "success", 12345, null, 900, JSON.stringify({ sha256: "abc" })]);
    expect(client.end).toHaveBeenCalledTimes(1);
    // The write path never touches the shared pool.
    expect(db.query).not.toHaveBeenCalled();
  });

  it("still ends the client when the insert fails", async () => {
    const client = makeFakeClient();
    client.query.mockRejectedValueOnce(new Error("insert failed"));
    Client.mockImplementation(() => client);

    await expect(record({ kind: "storage", status: "failed", connectionString: "postgres://x" })).rejects.toThrow(
      "insert failed"
    );
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it("throws without a connection string rather than connecting to nothing", async () => {
    await expect(record({ kind: "database", status: "success", connectionString: "" })).rejects.toThrow(
      /DATABASE_URL/
    );
    expect(Client).not.toHaveBeenCalled();
  });

  it("rounds non-integer bytes/objectCount/durationMs and nulls non-finite values", async () => {
    const client = makeFakeClient();
    Client.mockImplementation(() => client);

    await record({
      kind: "storage",
      status: "success",
      bytes: 100.7,
      objectCount: NaN,
      durationMs: undefined,
      connectionString: "postgres://x",
    });

    const [, params] = client.query.mock.calls[0];
    expect(params).toEqual(["storage", "success", 101, null, null, null]);
  });
});

describe("latest", () => {
  it("filters to successful runs of one kind", async () => {
    db.query.mockResolvedValue({ rows: [{ id: "run-1", kind: "database", status: "success" }] });

    const result = await latest({ kind: "database" });

    expect(result).toEqual({ id: "run-1", kind: "database", status: "success" });
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain("kind = $1 AND status = 'success'");
    expect(params).toEqual(["database"]);
  });

  it("returns null when there is no successful run yet", async () => {
    db.query.mockResolvedValue({ rows: [] });

    expect(await latest({ kind: "storage" })).toBeNull();
  });

  it("without a kind, still requires status = 'success'", async () => {
    db.query.mockResolvedValue({ rows: [] });

    await latest();

    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain("WHERE status = 'success'");
    expect(params).toEqual([]);
  });
});

describe("list", () => {
  beforeEach(() => {
    db.query.mockResolvedValueOnce({ rows: [{ id: "run-1" }] }).mockResolvedValueOnce({ rows: [{ total: 1 }] });
  });

  it("returns rows and total, unfiltered by default", async () => {
    const result = await list({ limit: 10, offset: 0 });

    expect(result).toEqual({ rows: [{ id: "run-1" }], total: 1 });
    const [listSql, listParams] = db.query.mock.calls[0];
    expect(listSql).not.toContain("WHERE");
    expect(listParams).toEqual([10, 0]);
  });

  it("includes failed runs too - a stalled backup is as newsworthy as a success", async () => {
    await list({ limit: 10, offset: 0, kind: "storage" });

    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain("kind = $1");
    expect(sql).not.toContain("status =");
    expect(params).toEqual(["storage", 10, 0]);
  });
});
