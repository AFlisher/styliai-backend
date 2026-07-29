"use strict";

/**
 * SEC-8.4 — deleteStyleAssets.
 *
 * The same guarded erase SEC-8.1A built for creations, applied to the other
 * mutation that leaked storage. The refusal tests matter more here than on the
 * creation path, not less: `style-images` is the catalog bucket, so a wrongly
 * erased object is a cover missing from the product rather than one stale
 * generation, and two styles can legitimately point at the same cover URL.
 */

jest.mock("../../config/db", () => ({ query: jest.fn() }));
jest.mock("../../config/supabase", () => ({ storage: { from: jest.fn() } }));

const db = require("../../config/db");
const supabase = require("../../config/supabase");
const { deleteStyleAssets } = require("../creationAssetCleanup");

const HOST = "https://proj.supabase.co/storage/v1/object/public";
const COVER_URL = `${HOST}/style-images/original/cover-1.png`;
const COVER_THUMB_URL = `${HOST}/style-images/thumbs/cover-1.webp`;
const AVATAR_URL = `${HOST}/avatars/11111111-2222-3333-4444-555555555555.jpg`;

let remove;

function nothingReferenced() {
  db.query.mockResolvedValue({ rows: [{ referenced: false }] });
}

function everythingReferenced() {
  db.query.mockResolvedValue({ rows: [{ referenced: true }] });
}

function logged() {
  const line = console.log.mock.calls
    .map(([l]) => l)
    .concat(console.error.mock.calls.map(([l]) => l))
    .find((l) => typeof l === "string" && l.includes("style_asset_erasure"));
  return line && JSON.parse(line);
}

beforeEach(() => {
  jest.clearAllMocks();
  remove = jest.fn().mockResolvedValue({ error: null });
  supabase.storage.from.mockReturnValue({ remove });
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  console.log.mockRestore();
  console.error.mockRestore();
});

describe("SEC-8.4 — erasing a deleted style's covers", () => {
  it("removes the cover and its thumbnail", async () => {
    nothingReferenced();

    const result = await deleteStyleAssets({ styleId: "s1", urls: [COVER_URL, COVER_THUMB_URL] });

    expect(supabase.storage.from).toHaveBeenCalledWith("style-images");
    expect(remove).toHaveBeenCalledWith(["original/cover-1.png", "thumbs/cover-1.webp"]);
    expect(result.deleted).toBe(2);
  });

  it("tolerates a style that never had a thumbnail", async () => {
    nothingReferenced();

    await deleteStyleAssets({ styleId: "s1", urls: [COVER_URL, null] });

    expect(remove).toHaveBeenCalledWith(["original/cover-1.png"]);
  });

  it("does nothing when the style had no cover at all", async () => {
    nothingReferenced();

    const result = await deleteStyleAssets({ styleId: "s1", urls: [null, null] });

    expect(remove).not.toHaveBeenCalled();
    expect(result.deleted).toBe(0);
    expect(logged()).toMatchObject({ outcome: "nothing_to_delete" });
  });
});

describe("SEC-8.4 — refusals", () => {
  it("keeps a cover another style still points at", async () => {
    // Nothing stops an admin reusing one cover URL across two styles; deleting
    // one must not blank the other.
    everythingReferenced();

    const result = await deleteStyleAssets({ styleId: "s1", urls: [COVER_URL, COVER_THUMB_URL] });

    expect(remove).not.toHaveBeenCalled();
    expect(result.deleted).toBe(0);
    expect(logged().skipped).toEqual([
      { reason: "still_referenced", bucket: "style-images", path: "original/cover-1.png" },
      { reason: "still_referenced", bucket: "style-images", path: "thumbs/cover-1.webp" },
    ]);
  });

  it("refuses to touch the avatars bucket", async () => {
    // Same allowlist as the creation path: avatar object names are user UUIDs.
    nothingReferenced();

    const result = await deleteStyleAssets({ styleId: "s1", urls: [AVATAR_URL, null] });

    expect(remove).not.toHaveBeenCalled();
    expect(result.deleted).toBe(0);
    expect(logged().skipped).toEqual([{ reason: "bucket_not_deletable", bucket: "avatars" }]);
  });

  it("ignores a value that is not one of our storage URLs", async () => {
    nothingReferenced();

    const result = await deleteStyleAssets({ styleId: "s1", urls: ["https://example.com/x.png", null] });

    expect(remove).not.toHaveBeenCalled();
    expect(result.deleted).toBe(0);
  });
});

describe("SEC-8.4 — failure handling and logging", () => {
  it("never throws when storage fails", async () => {
    nothingReferenced();
    remove.mockResolvedValue({ error: { message: "storage exploded" } });

    const result = await deleteStyleAssets({ styleId: "s1", urls: [COVER_URL, null] });

    expect(result).toMatchObject({ deleted: 0, failed: true });
  });

  it("logs a failure with the style id, not a creation id", async () => {
    nothingReferenced();
    remove.mockResolvedValue({ error: { message: "storage exploded" } });

    await deleteStyleAssets({ styleId: "s1", urls: [COVER_URL, null] });

    const line = logged();
    expect(line).toMatchObject({ event: "style_asset_erasure", outcome: "failed", styleId: "s1" });
    expect(line).not.toHaveProperty("creationId");
  });

  it("logs bucket and path, never a URL", async () => {
    nothingReferenced();

    await deleteStyleAssets({ styleId: "s1", urls: [COVER_URL, COVER_THUMB_URL] });

    const line = logged();
    expect(line.targets).toEqual([
      { bucket: "style-images", path: "original/cover-1.png" },
      { bucket: "style-images", path: "thumbs/cover-1.webp" },
    ]);
    expect(JSON.stringify(line)).not.toContain(HOST);
  });
});
