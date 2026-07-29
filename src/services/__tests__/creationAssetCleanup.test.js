// SEC-8.1A — storage erasure for deleted creations.
//
// Two families of assertion matter here and they pull in opposite directions.
// The erasure tests check that objects actually go away, because the whole
// finding is that they did not. The refusal tests check that the wrong objects
// never go away - and those are the dangerous ones, because this change is what
// turns `migrateCreations`' client-supplied imageUrl from an inert string into
// something that can destroy data.

jest.mock("../../config/db", () => ({ query: jest.fn() }));
jest.mock("../../config/supabase", () => ({ storage: { from: jest.fn() } }));

const db = require("../../config/db");
const supabase = require("../../config/supabase");
const {
  deleteCreationAssets,
  parseStorageUrl,
  isReferenced,
  resolveDeletableTargets,
  DELETABLE_BUCKETS,
} = require("../creationAssetCleanup");

const HOST = "https://proj.supabase.co/storage/v1/object/public";
const CREATION_URL = `${HOST}/creations/stability-abc.webp`;
const THUMB_URL = `${HOST}/creations/thumbs/stability-abc.webp`;
const STYLE_COVER_URL = `${HOST}/style-images/original/cover-1.png`;
const AVATAR_URL = `${HOST}/avatars/11111111-2222-3333-4444-555555555555.jpg`;

/** Nothing in the DB points at anything. */
function nothingReferenced() {
  db.query.mockResolvedValue({ rows: [{ referenced: false }] });
}
function everythingReferenced() {
  db.query.mockResolvedValue({ rows: [{ referenced: true }] });
}

let remove;
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

function logged() {
  return [...console.log.mock.calls, ...console.error.mock.calls].map((c) => String(c[0])).join("\n");
}
function event() {
  return JSON.parse(logged());
}

describe("URL parsing", () => {
  it("reads the bucket out of the URL, because a row can point at either", () => {
    // Both generation paths now write to `creations` (SEC-8.1B-1), but rows
    // predating that separation still point at `style-images`, and
    // `migrateCreations` accepts any URL a client sends. A caller-supplied
    // bucket would be wrong for exactly the rows that matter.
    expect(parseStorageUrl(CREATION_URL)).toEqual({ bucket: "creations", path: "stability-abc.webp" });
    expect(parseStorageUrl(THUMB_URL)).toEqual({ bucket: "creations", path: "thumbs/stability-abc.webp" });
    expect(parseStorageUrl(STYLE_COVER_URL)).toEqual({ bucket: "style-images", path: "original/cover-1.png" });
  });

  it("handles the legacy root layout as well as original/", () => {
    // Live data has both: originals uploaded before uploadOriginalWithThumbnail
    // sit at the bucket root, everything since sits under original/.
    expect(parseStorageUrl(`${HOST}/creations/root-file.webp`).path).toBe("root-file.webp");
    expect(parseStorageUrl(`${HOST}/creations/original/new-file.webp`).path).toBe("original/new-file.webp");
  });

  it("decodes percent-encoding", () => {
    expect(parseStorageUrl(`${HOST}/creations/a%20b.webp`).path).toBe("a b.webp");
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
    ["empty", ""],
    ["not a URL", "not a url"],
    ["a URL that is not a storage URL", "https://evil.example/creations/x.webp"],
    ["a storage URL with no object path", `${HOST}/creations/`],
    ["a storage URL with no bucket", `${HOST}//x.webp`],
    ["a signed-URL path we do not emit", "https://proj.supabase.co/storage/v1/object/sign/creations/x.webp"],
  ])("returns null for %s", (_label, input) => {
    expect(parseStorageUrl(input)).toBeNull();
  });
});

describe("the reference guard", () => {
  it("matches on the trailing /bucket/path, not on full-string equality", async () => {
    // Equality would be evaded by any URL addressing the same object through a
    // different host spelling or encoding - which is exactly what a crafted
    // migrateCreations payload would be.
    db.query.mockResolvedValue({ rows: [{ referenced: true }] });

    await isReferenced({ bucket: "creations", path: "thumbs/x.webp" });

    const [, params] = db.query.mock.calls[0];
    expect(params[0]).toBe("/creations/thumbs/x.webp");
    expect(params[1]).toBe("/creations/thumbs/x.webp".length);
  });

  it("checks every column in the schema that can hold a storage URL", async () => {
    db.query.mockResolvedValue({ rows: [{ referenced: false }] });

    await isReferenced({ bucket: "creations", path: "x.webp" });

    const [sql] = db.query.mock.calls[0];
    // A column added later without being added here would silently become
    // deletable, so pin the list.
    expect(sql).toMatch(/creations[\s\S]*image_url/);
    expect(sql).toMatch(/thumbnail_url/);
    expect(sql).toMatch(/styles[\s\S]*cover_image/);
    expect(sql).toMatch(/cover_image_thumbnail/);
    expect(sql).toMatch(/profiles[\s\S]*avatar_url/);
    expect(sql).toMatch(/users[\s\S]*avatar_url/);
  });
});

describe("erasure — the actual finding", () => {
  it("deletes both the original and the thumbnail", async () => {
    nothingReferenced();

    const result = await deleteCreationAssets({ creationId: "c-1", urls: [CREATION_URL, THUMB_URL] });

    expect(supabase.storage.from).toHaveBeenCalledWith("creations");
    expect(remove).toHaveBeenCalledWith(["stability-abc.webp", "thumbs/stability-abc.webp"]);
    expect(result.deleted).toBe(2);
  });

  // Pre-SEC-8.1B-1 this was the main /api/generate path. Generations now go to
  // `creations`, but rows written before the separation - and anything a client
  // migrates in - can still point at `style-images`, and those must keep
  // erasing rather than silently leaving their objects behind.
  it("deletes a creation stored in style-images (legacy or client-migrated)", async () => {
    nothingReferenced();

    await deleteCreationAssets({ creationId: "c-2", urls: [STYLE_COVER_URL, null] });

    expect(supabase.storage.from).toHaveBeenCalledWith("style-images");
    expect(remove).toHaveBeenCalledWith(["original/cover-1.png"]);
  });

  it("groups per bucket when original and thumbnail differ", async () => {
    nothingReferenced();

    await deleteCreationAssets({ creationId: "c-3", urls: [STYLE_COVER_URL, THUMB_URL] });

    const buckets = supabase.storage.from.mock.calls.map((c) => c[0]);
    expect(buckets).toEqual(["style-images", "creations"]);
  });

  it("does not hand remove() a duplicate when both columns are the same object", async () => {
    // Rows that predate thumbnails can carry the same URL twice.
    nothingReferenced();

    await deleteCreationAssets({ creationId: "c-4", urls: [CREATION_URL, CREATION_URL] });

    expect(remove).toHaveBeenCalledWith(["stability-abc.webp"]);
  });

  it("copes with a row whose thumbnail_url is null", async () => {
    nothingReferenced();

    const result = await deleteCreationAssets({ creationId: "c-5", urls: [CREATION_URL, null] });

    expect(result.deleted).toBe(1);
  });
});

describe("refusals — what must never be deleted", () => {
  it("refuses an object another row still references", async () => {
    everythingReferenced();

    const result = await deleteCreationAssets({ creationId: "c-6", urls: [CREATION_URL] });

    expect(remove).not.toHaveBeenCalled();
    expect(result.deleted).toBe(0);
    expect(result.skipped[0]).toMatchObject({ reason: "still_referenced" });
  });

  it("refuses an admin style cover reached through a crafted migrate row", async () => {
    // The concrete escalation this guard exists for: migrateCreations takes a
    // client-supplied imageUrl, so a caller could migrate a row pointing at a
    // catalog cover and then delete it. styles.cover_image still references the
    // object, so the delete is refused.
    everythingReferenced();

    await deleteCreationAssets({ creationId: "c-7", urls: [STYLE_COVER_URL] });

    expect(remove).not.toHaveBeenCalled();
  });

  it("refuses the avatars bucket outright, referenced or not", async () => {
    // Avatar object names ARE the owner's user UUID, so unlike every other
    // object here an attacker can name one without guessing. The bucket
    // allowlist blocks it before the reference check is even consulted.
    nothingReferenced();

    const result = await deleteCreationAssets({ creationId: "c-8", urls: [AVATAR_URL] });

    expect(remove).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
    expect(result.skipped[0]).toMatchObject({ reason: "bucket_not_deletable", bucket: "avatars" });
  });

  it("keeps avatars out of the allowlist", () => {
    expect(DELETABLE_BUCKETS.has("avatars")).toBe(false);
    expect([...DELETABLE_BUCKETS].sort()).toEqual(["creations", "style-images"]);
  });

  it("ignores a migrate URL that never pointed at our storage", async () => {
    const result = await deleteCreationAssets({ creationId: "c-9", urls: ["https://elsewhere.example/a.png"] });

    expect(remove).not.toHaveBeenCalled();
    expect(result.skipped[0]).toMatchObject({ reason: "unparseable_url" });
  });
});

describe("failure handling", () => {
  it("never throws when storage removal fails", async () => {
    // The controller has already deleted the row and answered the user. An
    // exception here would become a 500 on a deletion that in fact succeeded.
    nothingReferenced();
    remove.mockResolvedValue({ error: { message: "storage unavailable" } });

    await expect(deleteCreationAssets({ creationId: "c-10", urls: [CREATION_URL] })).resolves.toMatchObject({
      deleted: 0,
      failed: true,
    });
  });

  it("never throws when the reference check itself fails", async () => {
    db.query.mockRejectedValue(new Error("db down"));

    await expect(deleteCreationAssets({ creationId: "c-11", urls: [CREATION_URL] })).resolves.toMatchObject({
      failed: true,
    });
  });

  it("logs a failure loudly enough to be reconciled later", async () => {
    nothingReferenced();
    remove.mockResolvedValue({ error: { message: "storage unavailable" } });

    await deleteCreationAssets({ creationId: "c-12", urls: [CREATION_URL] });

    expect(console.error).toHaveBeenCalled();
    expect(event()).toMatchObject({ event: "creation_asset_erasure", outcome: "failed", creationId: "c-12" });
  });

  it("survives being handed no urls at all", async () => {
    await expect(deleteCreationAssets({ creationId: "c-13", urls: undefined })).resolves.toMatchObject({ deleted: 0 });
  });
});

describe("structured logging", () => {
  it("emits one parseable event carrying bucket and path, never a URL", async () => {
    // Paths are random UUID filenames already present in the public URL the
    // client holds, and they are the only way to act on a failed delete by
    // hand. The URL itself adds nothing and is not logged.
    nothingReferenced();

    await deleteCreationAssets({ creationId: "c-14", urls: [CREATION_URL, THUMB_URL] });

    const parsed = event();
    expect(parsed.outcome).toBe("deleted");
    expect(parsed.targets).toEqual([
      { bucket: "creations", path: "stability-abc.webp" },
      { bucket: "creations", path: "thumbs/stability-abc.webp" },
    ]);
    expect(logged()).not.toContain("proj.supabase.co");
  });

  it("makes a skip visible rather than looking like a successful no-op", async () => {
    everythingReferenced();

    await deleteCreationAssets({ creationId: "c-15", urls: [CREATION_URL] });

    expect(event()).toMatchObject({
      outcome: "nothing_to_delete",
      skipped: [{ reason: "still_referenced", bucket: "creations", path: "stability-abc.webp" }],
    });
  });
});

describe("resolveDeletableTargets", () => {
  it("reports refusals alongside targets so neither is silent", async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ referenced: false }] })
      .mockResolvedValueOnce({ rows: [{ referenced: true }] });

    const { targets, skipped } = await resolveDeletableTargets([CREATION_URL, THUMB_URL, AVATAR_URL, "junk"]);

    expect(targets).toEqual([{ bucket: "creations", path: "stability-abc.webp" }]);
    expect(skipped.map((s) => s.reason).sort()).toEqual(
      ["bucket_not_deletable", "still_referenced", "unparseable_url"].sort()
    );
  });
});
