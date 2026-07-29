"use strict";

/**
 * SEC-8.3 (leg C) — the avatar sweep's safety properties.
 *
 * Same shape as reconcileOrphanedCreations' tests, and for the same reason:
 * this tool rewrites production objects in place and the original bytes are
 * not kept anywhere, so the argument parsing IS the safety mechanism.
 */

jest.mock("../../config/db", () => ({ pool: { end: jest.fn() } }));
jest.mock("../../config/supabase", () => ({ storage: { from: jest.fn() } }));

const supabase = require("../../config/supabase");
const { __testing } = require("../stripAvatarMetadata");
const { parseArgs, listAvatars, BUCKET } = __testing;

describe("SEC-8.3 — stripAvatarMetadata argument parsing", () => {
  it("is a dry run by default", () => {
    expect(parseArgs([]).dryRun).toBe(true);
  });

  it("writes only when --apply is spelled out", () => {
    expect(parseArgs(["--apply"]).dryRun).toBe(false);
  });

  it.each([["--dry-run"], ["apply"], ["--applied"], ["--Apply"], ["--apply=true"]])(
    "stays a dry run for the near-miss argument %s",
    (arg) => {
      expect(parseArgs([arg]).dryRun).toBe(true);
    }
  );

  it("has no limit unless asked", () => {
    expect(parseArgs([]).limit).toBeUndefined();
    expect(parseArgs(["--limit=2"]).limit).toBe(2);
  });

  it("is locked to the avatars bucket with no way to redirect it", () => {
    expect(BUCKET).toBe("avatars");
    // No --bucket= handling exists at all; a caller cannot point this at the
    // product catalog by passing one.
    expect(parseArgs(["--bucket=style-images"])).not.toHaveProperty("bucket");
  });
});

describe("SEC-8.3 — stripAvatarMetadata listing", () => {
  afterEach(() => jest.clearAllMocks());

  it("skips Supabase's synthetic folder rows", async () => {
    supabase.storage.from.mockReturnValue({
      list: jest.fn().mockResolvedValue({
        data: [
          { name: "a.jpg", id: "1", metadata: { mimetype: "image/jpeg" } },
          { name: "somefolder", id: null },
          { name: "b.jpg", id: "2", metadata: { mimetype: "image/jpeg" } },
        ],
        error: null,
      }),
    });

    const objects = await listAvatars();

    expect(objects.map((o) => o.path)).toEqual(["a.jpg", "b.jpg"]);
  });

  it("defaults the content type when Supabase reports none", async () => {
    supabase.storage.from.mockReturnValue({
      list: jest.fn().mockResolvedValue({
        data: [{ name: "a.jpg", id: "1" }],
        error: null,
      }),
    });

    expect((await listAvatars())[0].contentType).toBe("image/jpeg");
  });

  it("surfaces a listing error instead of reporting an empty bucket", async () => {
    supabase.storage.from.mockReturnValue({
      list: jest.fn().mockResolvedValue({ data: null, error: { message: "boom" } }),
    });

    await expect(listAvatars()).rejects.toThrow(/list avatars failed: boom/);
  });

  it("paginates rather than truncating at the page size", async () => {
    const page = (n, offset) =>
      Array.from({ length: n }, (_, i) => ({ name: `${offset + i}.jpg`, id: `${offset + i}` }));
    const list = jest
      .fn()
      .mockResolvedValueOnce({ data: page(1000, 0), error: null })
      .mockResolvedValueOnce({ data: page(3, 1000), error: null });
    supabase.storage.from.mockReturnValue({ list });

    const objects = await listAvatars();

    expect(objects).toHaveLength(1003);
    expect(list).toHaveBeenCalledTimes(2);
    expect(list.mock.calls[1][1]).toMatchObject({ offset: 1000 });
  });
});
