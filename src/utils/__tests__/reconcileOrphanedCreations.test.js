// SEC-8.1A — the orphan reconciler.
//
// This script deletes irreversibly, so the assertions that earn their keep are
// the ones about refusing to: that a dry run is what you get unless you ask for
// otherwise, and that the age guard holds. Everything else is recoverable; a
// wrong delete here is not.

jest.mock("dotenv", () => ({ config: () => {} }));
jest.mock("../../config/db", () => ({ query: jest.fn(), pool: { end: jest.fn() } }));
jest.mock("../../config/supabase", () => ({ storage: { from: jest.fn() } }));

const supabase = require("../../config/supabase");
const { __testing } = require("../reconcileOrphanedCreations");
const { parseArgs, ageHours, listAllObjects } = __testing;

describe("dry run is the default", () => {
  it("does not delete unless --delete is spelled out", () => {
    // The opposite default to backfillThumbnails.js, deliberately: that script
    // only creates objects, this one destroys them with no undo.
    expect(parseArgs([]).dryRun).toBe(true);
    expect(parseArgs(["--bucket=creations"]).dryRun).toBe(true);
    expect(parseArgs(["--min-age-hours=0"]).dryRun).toBe(true);
    expect(parseArgs(["--delete"]).dryRun).toBe(false);
  });

  it("does not treat a near-miss spelling as consent to delete", () => {
    expect(parseArgs(["--dry-run"]).dryRun).toBe(true);
    expect(parseArgs(["delete"]).dryRun).toBe(true);
    expect(parseArgs(["--deleted"]).dryRun).toBe(true);
  });
});

describe("argument defaults", () => {
  it("targets creations, not the co-mingled style-images bucket", () => {
    // style-images holds admin catalog covers under the same prefixes as user
    // generations, so it has to be asked for by name.
    expect(parseArgs([]).bucket).toBe("creations");
    expect(parseArgs(["--bucket=style-images"]).bucket).toBe("style-images");
  });

  it("applies a 24h minimum age by default", () => {
    expect(parseArgs([]).minAgeHours).toBe(24);
    expect(parseArgs(["--min-age-hours=1"]).minAgeHours).toBe(1);
  });

  it("parses an optional limit", () => {
    expect(parseArgs([]).limit).toBeUndefined();
    expect(parseArgs(["--limit=5"]).limit).toBe(5);
  });
});

describe("the age guard", () => {
  it("treats a freshly uploaded object as too new", () => {
    // An object is uploaded before its row is written, so a generation in
    // flight is briefly indistinguishable from an orphan.
    const justNow = new Date(Date.now() - 60_000).toISOString();
    expect(ageHours(justNow)).toBeLessThan(1);
  });

  it("lets an old object through", () => {
    const lastWeek = new Date(Date.now() - 7 * 24 * 3_600_000).toISOString();
    expect(ageHours(lastWeek)).toBeGreaterThan(24);
  });

  it("treats an unknown or unparseable timestamp as old", () => {
    // The guard is a floor against the upload/insert race, not an ownership
    // check. An object whose age we cannot read still has to pass the
    // reference check before anything happens to it.
    expect(ageHours(null)).toBe(Infinity);
    expect(ageHours("not a date")).toBe(Infinity);
  });
});

describe("listing", () => {
  function pages(map) {
    supabase.storage.from.mockReturnValue({
      list: jest.fn(async (prefix) => ({ data: map[prefix] || [], error: null })),
    });
  }

  it("recurses into prefixes, so both storage layouts are covered", async () => {
    // Live data has legacy originals at the bucket root and everything since
    // under original/ and thumbs/.
    pages({
      "": [
        { name: "stability-a.webp", id: "1", created_at: "2026-01-01T00:00:00Z" },
        { name: "thumbs", id: null },
        { name: "original", id: null },
      ],
      thumbs: [{ name: "stability-a.webp", id: "2", created_at: "2026-01-01T00:00:00Z" }],
      original: [{ name: "gen-b.webp", id: "3", created_at: "2026-01-02T00:00:00Z" }],
    });

    const objects = await listAllObjects("creations");

    expect(objects.map((o) => o.path).sort()).toEqual(
      ["original/gen-b.webp", "stability-a.webp", "thumbs/stability-a.webp"].sort()
    );
  });

  it("surfaces a listing error instead of reporting an empty bucket", async () => {
    // Silently reading a failed listing as "no objects" is harmless here, but
    // the same mistake in the opposite direction would be catastrophic. Fail loud.
    supabase.storage.from.mockReturnValue({
      list: jest.fn(async () => ({ data: null, error: { message: "denied" } })),
    });

    await expect(listAllObjects("creations")).rejects.toThrow(/denied/);
  });

  it("carries created_at through, since the age guard depends on it", async () => {
    pages({ "": [{ name: "a.webp", id: "1", created_at: "2026-03-04T05:06:07Z" }] });

    const [object] = await listAllObjects("creations");

    expect(object.createdAt).toBe("2026-03-04T05:06:07Z");
  });
});
