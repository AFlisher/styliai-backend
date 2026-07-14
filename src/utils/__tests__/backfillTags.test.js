// backfillTags.js runs main() as a side effect of being required (same
// one-off-script shape as createAdmin.js/runMigration.js), so each test
// mocks its dependencies fresh via jest.doMock + resetModules, then requires
// the module and waits for the promise chain to finish (signaled by the
// mocked db.pool.end(), which is always the last thing main() calls).

describe("backfillTags", () => {
  let styleModel;
  let categoryModel;
  let autoTagService;
  let db;
  const originalArgv = process.argv;

  beforeEach(() => {
    jest.resetModules();
    // Default to no inter-style delay so unrelated tests stay fast; the
    // dedicated delay test below overrides this.
    process.env.AUTOTAG_BACKFILL_DELAY_MS = "0";

    jest.doMock("../../config/db", () => ({ pool: { end: jest.fn().mockResolvedValue(undefined) } }));
    jest.doMock("../../models/styleModel", () => ({
      getStylesNeedingAutoTag: jest.fn(),
      setStyleTagsAutoAssigned: jest.fn().mockResolvedValue(undefined),
    }));
    jest.doMock("../../models/categoryModel", () => ({ getAllCategories: jest.fn().mockResolvedValue([]) }));
    jest.doMock("../../services/autoTagService", () => ({ suggestTagsForStyle: jest.fn() }));

    styleModel = require("../../models/styleModel");
    categoryModel = require("../../models/categoryModel");
    autoTagService = require("../../services/autoTagService");
    db = require("../../config/db");

    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.argv = originalArgv;
    delete process.env.AUTOTAG_BACKFILL_DELAY_MS;
    delete process.env.AUTOTAG_BACKFILL_CONCURRENCY;
    console.log.mockRestore();
    console.error.mockRestore();
  });

  function run(extraArgs = []) {
    process.argv = ["node", "backfillTags.js", ...extraArgs];
    let resolveFinished;
    const finished = new Promise((resolve) => {
      resolveFinished = resolve;
    });
    db.pool.end.mockImplementation(() => {
      resolveFinished();
      return Promise.resolve();
    });
    require("../backfillTags");
    return finished;
  }

  it("classifies and writes tags for each untagged style via the same autoTagService pipeline", async () => {
    categoryModel.getAllCategories.mockResolvedValue([{ id: "cat-1", name: "Fantasy" }]);
    styleModel.getStylesNeedingAutoTag.mockResolvedValue([
      { id: "s1", name: "Style 1", prompt: "p1", categoryId: "cat-1" },
    ]);
    autoTagService.suggestTagsForStyle.mockResolvedValue({ tagIds: ["t1"], status: "ok" });

    await run();

    expect(autoTagService.suggestTagsForStyle).toHaveBeenCalledWith({
      name: "Style 1",
      prompt: "p1",
      categoryName: "Fantasy",
    });
    expect(styleModel.setStyleTagsAutoAssigned).toHaveBeenCalledWith("s1", ["t1"]);
  });

  it("--dry-run classifies but never writes", async () => {
    styleModel.getStylesNeedingAutoTag.mockResolvedValue([
      { id: "s1", name: "Style 1", prompt: "p1", categoryId: "cat-1" },
    ]);
    autoTagService.suggestTagsForStyle.mockResolvedValue({ tagIds: ["t1"], status: "ok" });

    await run(["--dry-run"]);

    expect(autoTagService.suggestTagsForStyle).toHaveBeenCalledTimes(1);
    expect(styleModel.setStyleTagsAutoAssigned).not.toHaveBeenCalled();
  });

  it("--limit=N caps how many styles are processed", async () => {
    styleModel.getStylesNeedingAutoTag.mockResolvedValue([
      { id: "s1", name: "A", prompt: "p", categoryId: "cat-1" },
      { id: "s2", name: "B", prompt: "p", categoryId: "cat-1" },
      { id: "s3", name: "C", prompt: "p", categoryId: "cat-1" },
    ]);
    autoTagService.suggestTagsForStyle.mockResolvedValue({ tagIds: [], status: "empty" });

    await run(["--limit=1"]);

    expect(autoTagService.suggestTagsForStyle).toHaveBeenCalledTimes(1);
  });

  it("isolates a per-style failure - one bad style doesn't stop the rest of the batch", async () => {
    styleModel.getStylesNeedingAutoTag.mockResolvedValue([
      { id: "s1", name: "A", prompt: "p", categoryId: "cat-1" },
      { id: "s2", name: "B", prompt: "p", categoryId: "cat-1" },
    ]);
    autoTagService.suggestTagsForStyle.mockResolvedValue({ tagIds: ["t1"], status: "ok" });
    styleModel.setStyleTagsAutoAssigned
      .mockRejectedValueOnce(new Error("db blip"))
      .mockResolvedValueOnce(undefined);

    await run();

    expect(styleModel.setStyleTagsAutoAssigned).toHaveBeenCalledTimes(2);
  });

  it("leaves a style untouched (no write) when both models are exhausted, so it stays pending for the next run", async () => {
    styleModel.getStylesNeedingAutoTag.mockResolvedValue([
      { id: "s1", name: "A", prompt: "p", categoryId: "cat-1" },
    ]);
    autoTagService.suggestTagsForStyle.mockResolvedValue({ tagIds: [], status: "error", errorMessage: "both models exhausted" });

    await run();

    expect(styleModel.setStyleTagsAutoAssigned).not.toHaveBeenCalled();
  });

  it("still writes a genuinely empty classification (status 'empty') - that's a real result, not a pending failure", async () => {
    styleModel.getStylesNeedingAutoTag.mockResolvedValue([
      { id: "s1", name: "A", prompt: "p", categoryId: "cat-1" },
    ]);
    autoTagService.suggestTagsForStyle.mockResolvedValue({ tagIds: [], status: "empty" });

    await run();

    expect(styleModel.setStyleTagsAutoAssigned).toHaveBeenCalledWith("s1", []);
  });

  it("waits AUTOTAG_BACKFILL_DELAY_MS between styles, but not after the last one", async () => {
    process.env.AUTOTAG_BACKFILL_DELAY_MS = "2000";
    styleModel.getStylesNeedingAutoTag.mockResolvedValue([
      { id: "s1", name: "A", prompt: "p", categoryId: "cat-1" },
      { id: "s2", name: "B", prompt: "p", categoryId: "cat-1" },
    ]);
    autoTagService.suggestTagsForStyle.mockResolvedValue({ tagIds: ["t1"], status: "ok" });

    jest.useFakeTimers();
    const setTimeoutSpy = jest.spyOn(global, "setTimeout");
    const finished = run();
    await jest.runAllTimersAsync();
    await finished;
    jest.useRealTimers();

    const delayCalls = setTimeoutSpy.mock.calls.filter(([, ms]) => ms === 2000);
    expect(delayCalls.length).toBe(1); // between s1 and s2, not after s2
    expect(autoTagService.suggestTagsForStyle).toHaveBeenCalledTimes(2);
  });

  it("defaults to concurrency 1 (serial) when AUTOTAG_BACKFILL_CONCURRENCY is unset", async () => {
    styleModel.getStylesNeedingAutoTag.mockResolvedValue([
      { id: "s1", name: "A", prompt: "p", categoryId: "cat-1" },
      { id: "s2", name: "B", prompt: "p", categoryId: "cat-1" },
    ]);

    let resolveFirst;
    const firstCallGate = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    autoTagService.suggestTagsForStyle
      .mockImplementationOnce(async () => {
        await firstCallGate;
        return { tagIds: ["t1"], status: "ok" };
      })
      .mockResolvedValueOnce({ tagIds: ["t1"], status: "ok" });

    const finished = run();

    // With true concurrency 1, the second style must not be requested
    // until the first worker call actually resolves.
    await Promise.resolve();
    await Promise.resolve();
    expect(autoTagService.suggestTagsForStyle).toHaveBeenCalledTimes(1);

    resolveFirst();
    await finished;

    expect(autoTagService.suggestTagsForStyle).toHaveBeenCalledTimes(2);
  });

  it("always closes the db pool so the script actually exits", async () => {
    styleModel.getStylesNeedingAutoTag.mockResolvedValue([]);

    await run();

    expect(db.pool.end).toHaveBeenCalledTimes(1);
  });
});
