"use strict";

/**
 * SEC-8.4 — the reference guard must not depend on how an object's name is
 * spelled in the stored URL.
 *
 * The two callers disagreed about representation. `parseStorageUrl` decodes
 * before handing over a path (so the erasure path passes `my file.webp`), while
 * the reconciler passes the raw name from a storage listing — and both were
 * compared against the stored URL as written, which is percent-encoded
 * (`my%20file.webp`). For UUID filenames the two spellings are identical, which
 * is why production has always matched and why this never fired.
 *
 * It fails in both dangerous directions the moment a name needs encoding: the
 * erasure guard stops seeing a live reference, and the reconciler reclassifies
 * a referenced object as an orphan and deletes it. These tests pin the
 * reconciliation of the two spellings, using names that actually require it.
 */

jest.mock("../../config/db", () => ({ query: jest.fn() }));
jest.mock("../../config/supabase", () => ({ storage: { from: jest.fn() } }));

const db = require("../../config/db");
const { referenceSuffixes, isReferenced, parseStorageUrl } = require("../creationAssetCleanup");

const HOST = "https://x.supabase.co/storage/v1/object/public";

describe("SEC-8.4 — referenceSuffixes", () => {
  it("produces one spelling for a UUID name, which is why nothing broke before", () => {
    const { decoded, encoded } = referenceSuffixes(
      "creations",
      "original/3fd228b6-cdb7-40a0-b1c6-286023f2d19c.webp"
    );

    expect(decoded).toBe(encoded);
  });

  it.each([
    ["a space", "original/my file.webp", "original/my%20file.webp"],
    ["an accent", "original/café.png", "original/caf%C3%A9.png"],
    ["a literal percent", "original/100%.jpg", "original/100%25.jpg"],
  ])("produces both spellings for %s", (_label, path, encodedPath) => {
    const { decoded, encoded } = referenceSuffixes("creations", path);

    expect(decoded).toBe(`/creations/${path}`);
    expect(encoded).toBe(`/creations/${encodedPath}`);
    expect(decoded).not.toBe(encoded);
  });

  it("leaves the path separators and unreserved characters alone", () => {
    // encodeURIComponent would escape the slashes and the ampersand, producing
    // a suffix that matches nothing at all.
    const { encoded } = referenceSuffixes("creations", "original/a+b&c.jpg");

    expect(encoded).toBe("/creations/original/a+b&c.jpg");
  });
});

describe("SEC-8.4 — the guard checks both spellings", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.query.mockResolvedValue({ rows: [{ referenced: false }] });
  });

  it("passes the decoded and encoded suffixes with their own lengths", async () => {
    await isReferenced({ bucket: "creations", path: "original/my file.webp" });

    const [, params] = db.query.mock.calls[0];
    expect(params[0]).toBe("/creations/original/my file.webp");
    expect(params[1]).toBe("/creations/original/my file.webp".length);
    expect(params[2]).toBe("/creations/original/my%20file.webp");
    expect(params[3]).toBe("/creations/original/my%20file.webp".length);
  });

  it("compares every URL column against both spellings", async () => {
    await isReferenced({ bucket: "creations", path: "original/my file.webp" });

    const [sql] = db.query.mock.calls[0];
    // Each column must appear with both the $1/$2 and the $3/$4 pair; a column
    // checked against only one spelling is a column that can silently drop a
    // reference. SEC-8.4B added the query-string strip, so the column is now
    // read through split_part - asserted here too, since a column compared
    // without it drops references exactly the same way.
    for (const column of [
      "image_url",
      "thumbnail_url",
      "cover_image",
      "cover_image_thumbnail",
      "avatar_url",
    ]) {
      expect(sql).toMatch(
        new RegExp(`right\\(split_part\\(${column}, '\\?', 1\\), \\$2\\) = \\$1`)
      );
      expect(sql).toMatch(
        new RegExp(`right\\(split_part\\(${column}, '\\?', 1\\), \\$4\\) = \\$3`)
      );
    }
  });
});

describe("SEC-8.4 — the two callers reconcile", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.query.mockResolvedValue({ rows: [{ referenced: true }] });
  });

  it("a path parsed out of an encoded URL still matches that URL", async () => {
    // This is the actual bug, end to end: parseStorageUrl decodes, so the
    // suffix built from its output could never match the URL it came from.
    const storedUrl = `${HOST}/creations/original/my%20file.webp`;
    const parsed = parseStorageUrl(storedUrl);
    expect(parsed.path).toBe("original/my file.webp"); // decoded, as before

    const { encoded } = referenceSuffixes(parsed.bucket, parsed.path);

    expect(storedUrl.endsWith(encoded)).toBe(true);
  });

  it("a raw listing path still matches the URL that references it", async () => {
    // The reconciler's direction: it passes the name exactly as storage lists
    // it, and the row holds the encoded URL.
    const listingPath = "original/café.png";
    const storedUrl = `${HOST}/creations/original/caf%C3%A9.png`;

    const { encoded } = referenceSuffixes("creations", listingPath);

    expect(storedUrl.endsWith(encoded)).toBe(true);
  });

  it("still reports a reference for ordinary UUID objects", async () => {
    // The common path must be untouched by all of the above.
    const referenced = await isReferenced({
      bucket: "creations",
      path: "original/3fd228b6-cdb7-40a0-b1c6-286023f2d19c.webp",
    });

    expect(referenced).toBe(true);
  });
});
