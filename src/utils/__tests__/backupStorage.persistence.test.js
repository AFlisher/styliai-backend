// System Health module: pins that a successful backupStorage() run records
// itself to backup_runs with status derived from manifest.complete (an
// incomplete backup must never read as a success), and that a recording
// failure never turns a completed backup into a reported failure.

jest.mock("../../config/supabase", () => ({ storage: { from: jest.fn() } }));
jest.mock("fs", () => ({
  existsSync: jest.fn(() => false),
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
}));
jest.mock("../../models/backupRunModel", () => ({ record: jest.fn().mockResolvedValue(undefined) }));

const supabase = require("../../config/supabase");
const backupRunModel = require("../../models/backupRunModel");
const { backupStorage } = require("../backupStorage");

function mockOneObjectBucket({ downloadFails = false } = {}) {
  const list = jest
    .fn()
    .mockResolvedValueOnce({ data: [{ id: "obj-1", name: "a.png", metadata: { size: 10 } }], error: null })
    .mockResolvedValueOnce({ data: [], error: null });

  const download = downloadFails
    ? jest.fn().mockResolvedValue({ data: null, error: { message: "not found" } })
    : jest.fn().mockResolvedValue({ data: { arrayBuffer: async () => Buffer.from("x") }, error: null });

  supabase.storage.from.mockReturnValue({ list, download });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  console.error.mockRestore();
});

describe("backupStorage - backup_runs recording", () => {
  it("records status:success with totals when the backup is complete", async () => {
    mockOneObjectBucket();

    await backupStorage({ buckets: ["test-bucket"], outputDir: "/tmp/storage-backups" });

    expect(backupRunModel.record).toHaveBeenCalledTimes(1);
    const entry = backupRunModel.record.mock.calls[0][0];
    expect(entry.kind).toBe("storage");
    expect(entry.status).toBe("success");
    expect(entry.objectCount).toBe(1);
    expect(entry.detail.buckets).toEqual(["test-bucket"]);
    expect(entry.detail.failureCount).toBe(0);
  });

  it("records status:failed when an object could not be downloaded, even though the script completes", async () => {
    mockOneObjectBucket({ downloadFails: true });

    await backupStorage({ buckets: ["test-bucket"], outputDir: "/tmp/storage-backups" });

    const entry = backupRunModel.record.mock.calls[0][0];
    expect(entry.status).toBe("failed");
    expect(entry.detail.failureCount).toBe(1);
  });

  it("still returns the manifest even when recording the backup run fails", async () => {
    mockOneObjectBucket();
    backupRunModel.record.mockRejectedValueOnce(new Error("db unreachable"));

    const result = await backupStorage({ buckets: ["test-bucket"], outputDir: "/tmp/storage-backups" });

    expect(result.manifest.complete).toBe(true);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("failed to record backup run"));
  });
});
