// System Health module: pins that a successful backupDatabase() run records
// itself to backup_runs, and that a failure to record never turns a
// completed, on-disk backup into a reported failure. The pg_dump/fs
// machinery itself is mocked minimally, just enough to reach the success
// path this test is actually about.

const { EventEmitter } = require("events");

jest.mock("child_process", () => ({ spawn: jest.fn(), execFile: jest.fn() }));
jest.mock("fs", () => ({
  mkdirSync: jest.fn(),
  existsSync: jest.fn(() => false),
  statSync: jest.fn(() => ({ size: 4096 })),
  writeFileSync: jest.fn(),
  createReadStream: jest.fn(),
}));
jest.mock("../../models/backupRunModel", () => ({ record: jest.fn().mockResolvedValue(undefined) }));

const fs = require("fs");
const { spawn, execFile } = require("child_process");
const backupRunModel = require("../../models/backupRunModel");
const { backupDatabase } = require("../backupDatabase");

function mockSuccessfulPgDump() {
  execFile.mockImplementation((_cmd, _args, cb) => cb(null, "pg_dump (PostgreSQL) 15.4"));

  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  spawn.mockReturnValue(child);
  // spawn's caller attaches listeners synchronously then this test fires
  // 'close' on the next tick, mirroring a real child process.
  setImmediate(() => child.emit("close", 0));

  // sha256File streams the dump file - a fake stream that immediately ends.
  const stream = new EventEmitter();
  fs.createReadStream.mockReturnValue(stream);
  setImmediate(() => {
    stream.emit("data", Buffer.from("dump-bytes"));
    stream.emit("end");
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  console.error.mockRestore();
});

describe("backupDatabase - backup_runs recording", () => {
  it("records a success row with the manifest's bytes, duration and checksum", async () => {
    mockSuccessfulPgDump();

    await backupDatabase({ connectionString: "postgres://u:p@host/db", outputDir: "/tmp/backups" });

    expect(backupRunModel.record).toHaveBeenCalledTimes(1);
    const entry = backupRunModel.record.mock.calls[0][0];
    expect(entry.kind).toBe("database");
    expect(entry.status).toBe("success");
    expect(entry.bytes).toBe(4096);
    expect(typeof entry.durationMs).toBe("number");
    expect(entry.detail).toMatchObject({ pgDumpVersion: "pg_dump (PostgreSQL) 15.4" });
    expect(entry.detail.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("still returns the manifest even when recording the backup run fails", async () => {
    mockSuccessfulPgDump();
    backupRunModel.record.mockRejectedValueOnce(new Error("db unreachable"));

    const result = await backupDatabase({ connectionString: "postgres://u:p@host/db", outputDir: "/tmp/backups" });

    expect(result.manifest.bytes).toBe(4096);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("failed to record backup run"));
  });
});
