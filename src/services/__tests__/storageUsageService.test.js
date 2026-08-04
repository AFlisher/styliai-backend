const mockList = jest.fn();

jest.mock("../../config/supabase", () => ({
  storage: { from: () => ({ list: mockList }) },
}));

const service = require("../storageUsageService");

/** Builds a page of `n` objects each `size` bytes. */
function page(n, size = 1024 * 1024) {
  return { data: Array.from({ length: n }, () => ({ metadata: { size } })), error: null };
}

beforeEach(() => {
  jest.clearAllMocks();
  service.resetCache();
});

describe("SEC-19.1 — the walk is bounded", () => {
  it("stops at a short page and reports a complete figure", async () => {
    mockList.mockResolvedValueOnce(page(100)).mockResolvedValueOnce(page(30));

    const result = await service.getStorageUsage();

    expect(mockList).toHaveBeenCalledTimes(2);
    expect(result.megabytes).toBe(130);
    expect(result.objectCount).toBe(130);
    expect(result.truncated).toBe(false);
  });

  it("stops at an empty page", async () => {
    mockList.mockResolvedValueOnce(page(100)).mockResolvedValueOnce(page(0));
    const result = await service.getStorageUsage();
    expect(result.megabytes).toBe(100);
    expect(result.truncated).toBe(false);
  });

  // THE FINDING: the original `while (true)` had no iteration cap, so cost
  // scaled with total lifetime usage. This is the assertion that it now cannot.
  it("stops at MAX_PAGES on a bucket that never returns a short page", async () => {
    mockList.mockResolvedValue(page(100));

    const result = await service.getStorageUsage();

    expect(mockList).toHaveBeenCalledTimes(service.MAX_PAGES);
    expect(result.truncated).toBe(true);
  });

  it("stops at the wall-clock deadline even below MAX_PAGES", async () => {
    mockList.mockResolvedValue(page(100));
    // A clock that jumps past the deadline after the second page.
    let calls = 0;
    const now = () => {
      calls += 1;
      return calls > 2 ? service.DEADLINE_MS + 1000 : 0;
    };

    const result = await service.computeUsage(now);

    expect(result.truncated).toBe(true);
    expect(mockList.mock.calls.length).toBeLessThan(service.MAX_PAGES);
  });

  it("advances the offset so it does not re-read page one forever", async () => {
    mockList.mockResolvedValueOnce(page(100)).mockResolvedValueOnce(page(5));
    await service.getStorageUsage();
    expect(mockList.mock.calls[0][1]).toMatchObject({ offset: 0 });
    expect(mockList.mock.calls[1][1]).toMatchObject({ offset: 100 });
  });

  it("tolerates objects with missing size metadata", async () => {
    mockList.mockResolvedValueOnce({
      data: [{ metadata: { size: 1024 * 1024 } }, {}, { metadata: {} }],
      error: null,
    });
    const result = await service.getStorageUsage();
    expect(result.megabytes).toBe(1);
  });
});

describe("SEC-19.1 — caching", () => {
  it("serves the cached figure within the TTL without re-walking", async () => {
    mockList.mockResolvedValueOnce(page(10));

    const first = await service.getStorageUsage();
    const second = await service.getStorageUsage();

    expect(mockList).toHaveBeenCalledTimes(1);
    expect(second.cached).toBe(true);
    expect(second.megabytes).toBe(first.megabytes);
  });

  it("re-walks once the TTL has elapsed", async () => {
    mockList.mockResolvedValue(page(10));

    await service.getStorageUsage();
    await service.getStorageUsage({ now: () => Date.now() + service.TTL_MS + 1 });

    expect(mockList).toHaveBeenCalledTimes(2);
  });

  it("carries an asOf timestamp so the dashboard can state its staleness", async () => {
    mockList.mockResolvedValueOnce(page(1));
    const result = await service.getStorageUsage();
    expect(Date.parse(result.asOf)).not.toBeNaN();
  });
});

describe("SEC-19.1 — the refresh storm (the audit's attack scenario)", () => {
  // "An admin opens the dashboard; the request hangs, they refresh, and each
  // refresh starts another full bucket walk." A TTL alone does NOT stop this,
  // because every request arriving before the first completes sees an empty
  // cache. Single-flight is what closes it.
  it("collapses concurrent callers onto ONE walk", async () => {
    let resolvePage;
    mockList.mockImplementationOnce(
      () => new Promise((r) => { resolvePage = () => r(page(5)); })
    );

    const inFlight = [
      service.getStorageUsage(),
      service.getStorageUsage(),
      service.getStorageUsage(),
      service.getStorageUsage(),
    ];

    resolvePage();
    const results = await Promise.all(inFlight);

    expect(mockList).toHaveBeenCalledTimes(1);
    for (const r of results) expect(r.megabytes).toBe(5);
  });
});

describe("SEC-19.1 — never breaks the dashboard", () => {
  it("returns an unavailable figure rather than throwing on a storage error", async () => {
    mockList.mockResolvedValueOnce({ data: null, error: new Error("supabase down") });

    const result = await service.getStorageUsage();

    expect(result.unavailable).toBe(true);
    expect(result.megabytes).toBeNull();
  });

  it("serves the last good value when a later refresh fails", async () => {
    mockList.mockResolvedValueOnce(page(7));
    await service.getStorageUsage();

    mockList.mockResolvedValueOnce({ data: null, error: new Error("down") });
    const stale = await service.getStorageUsage({ now: () => Date.now() + service.TTL_MS + 1 });

    expect(stale.megabytes).toBe(7);
    expect(stale.stale).toBe(true);
  });

  it("never rejects, whatever the storage layer does", async () => {
    mockList.mockRejectedValueOnce(new Error("network exploded"));
    await expect(service.getStorageUsage()).resolves.toBeDefined();
  });

  it("recovers on the next refresh after a failure", async () => {
    mockList.mockRejectedValueOnce(new Error("blip"));
    await service.getStorageUsage();

    mockList.mockResolvedValueOnce(page(3));
    const ok = await service.getStorageUsage({ now: () => Date.now() + service.TTL_MS + 1 });
    expect(ok.megabytes).toBe(3);
  });
});

describe("SEC-19.1 — VACUITY probes", () => {
  // If the service ignored the mock and returned a constant, every assertion
  // above would be meaningless. These state the negatives directly.
  it("VACUITY: the figure actually reflects the listed objects", async () => {
    mockList.mockResolvedValueOnce(page(3, 2 * 1024 * 1024));
    const a = await service.getStorageUsage();
    expect(a.megabytes).toBe(6);

    service.resetCache();
    mockList.mockResolvedValueOnce(page(3, 4 * 1024 * 1024));
    const b = await service.getStorageUsage();
    expect(b.megabytes).toBe(12);
  });

  it("VACUITY: MAX_PAGES is a real, finite, positive bound", () => {
    expect(Number.isInteger(service.MAX_PAGES)).toBe(true);
    expect(service.MAX_PAGES).toBeGreaterThan(0);
    expect(service.MAX_PAGES).toBeLessThan(100000);
  });

  it("VACUITY: resetCache genuinely clears, so cache tests are not self-fulfilling", async () => {
    mockList.mockResolvedValue(page(1));
    await service.getStorageUsage();
    service.resetCache();
    await service.getStorageUsage();
    expect(mockList).toHaveBeenCalledTimes(2);
  });
});
