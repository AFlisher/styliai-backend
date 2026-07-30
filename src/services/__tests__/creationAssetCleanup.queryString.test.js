"use strict";

/**
 * SEC-8.4B — the reference guard must not depend on whether the stored URL
 * carries a query string.
 *
 * The guard matches a trailing `/<bucket>/<path>`. That is only the suffix of a
 * URL that *ends* at the path, and `profiles.avatar_url` does not: uploadAvatar
 * appends a `?v=<epoch_ms>` CDN cache-buster. Measured against production
 * before the fix, for a live and plainly referenced avatar:
 *
 *   suffix match (what isReferenced did):  false
 *   contains match:                        true
 *   stored: .../avatars/f60f71b5-….jpg?v=1784034159601
 *
 * SEC-8.4 made this comparison independent of percent-encoding. A query string
 * is a third representation of the same object, and nothing accounted for it.
 *
 * The danger is one-directional and latent. The guard answers "is anything
 * still pointing at this object?", and a false "no" is what authorises a
 * delete - so this under-reports references, which is the direction that
 * deletes live data. It is inert only because `avatars` is not in
 * DELETABLE_BUCKETS; adding it without this fix would classify every live
 * avatar as an orphan.
 */

jest.mock("../../config/db", () => ({ query: jest.fn() }));
jest.mock("../../config/supabase", () => ({ storage: { from: jest.fn() } }));

const db = require("../../config/db");
const {
  isReferenced,
  parseStorageUrl,
  referenceSuffixes,
} = require("../creationAssetCleanup");

const HOST = "https://x.supabase.co/storage/v1/object/public";

/**
 * What Postgres computes for `right(split_part(col, '?', 1), n) = suffix`.
 *
 * Asserting the SQL string proves the query was written as intended; it cannot
 * prove the query answers correctly. This models the two functions actually
 * used so the tests below exercise the real matching semantics.
 */
function matchesUnderGuard(storedUrl, { decoded, encoded }) {
  const withoutQuery = storedUrl.split("?")[0]; // split_part(col, '?', 1)
  return withoutQuery.endsWith(decoded) || withoutQuery.endsWith(encoded);
}

describe("SEC-8.4B — matching ignores the query string", () => {
  it("still matches a URL with no query string (the creations case, unchanged)", () => {
    const stored = `${HOST}/creations/original/3fd228b6.webp`;
    const suffixes = referenceSuffixes("creations", "original/3fd228b6.webp");

    expect(matchesUnderGuard(stored, suffixes)).toBe(true);
  });

  it("matches a URL carrying the ?v= cache-buster (the avatar case, the bug)", () => {
    const stored = `${HOST}/avatars/f60f71b5.jpg?v=1784034159601`;
    const suffixes = referenceSuffixes("avatars", "f60f71b5.jpg");

    expect(matchesUnderGuard(stored, suffixes)).toBe(true);
  });

  it("fails without the strip, which is what made this a landmine", () => {
    // The pre-fix behaviour, stated explicitly: a live reference reported as
    // absent. Deleting on that answer is what would have destroyed the avatars.
    const stored = `${HOST}/avatars/f60f71b5.jpg?v=1784034159601`;
    const { decoded } = referenceSuffixes("avatars", "f60f71b5.jpg");

    expect(stored.endsWith(decoded)).toBe(false); // no strip -> missed
    expect(stored.split("?")[0].endsWith(decoded)).toBe(true); // strip -> found
  });

  it.each([
    ["?v=1", "?v=1"],
    ["a long cache-buster", "?v=1784034159601"],
    ["several parameters", "?v=1&width=320&quality=85"],
    ["a parameter with no value", "?v="],
    ["a bare question mark", "?"],
    ["a token-shaped parameter", "?token=abc.def.ghi&expires=99"],
  ])("is unaffected by %s", (_label, query) => {
    const stored = `${HOST}/avatars/f60f71b5.jpg${query}`;
    const suffixes = referenceSuffixes("avatars", "f60f71b5.jpg");

    expect(matchesUnderGuard(stored, suffixes)).toBe(true);
  });

  it("keeps encoded paths working, with and without a query string", () => {
    // SEC-8.4's property must survive SEC-8.4B: the encoded spelling is what
    // the stored URL actually uses, and the strip must not disturb it.
    const suffixes = referenceSuffixes("creations", "original/my file.webp");

    expect(matchesUnderGuard(`${HOST}/creations/original/my%20file.webp`, suffixes)).toBe(true);
    expect(
      matchesUnderGuard(`${HOST}/creations/original/my%20file.webp?v=17`, suffixes)
    ).toBe(true);
  });

  it("keeps an accented encoded path working with a query string", () => {
    const suffixes = referenceSuffixes("creations", "original/café.png");

    expect(matchesUnderGuard(`${HOST}/creations/original/caf%C3%A9.png?v=9`, suffixes)).toBe(true);
  });

  it("does not match a different object that merely shares a query string", () => {
    // The strip must not widen the match. This is the direction that would
    // wrongly PRESERVE an orphan, which is the safe direction - but a guard
    // that matches too much is still a broken guard.
    const stored = `${HOST}/creations/original/someone-else.webp?v=1`;
    const suffixes = referenceSuffixes("creations", "original/3fd228b6.webp");

    expect(matchesUnderGuard(stored, suffixes)).toBe(false);
  });

  it("does not let a query string forge a match on the path", () => {
    // A crafted migrateCreations payload could put the target path in the
    // query rather than the path. Everything after the first '?' is discarded,
    // so it cannot be used to claim a reference to an object.
    const stored = `${HOST}/creations/original/attacker.webp?x=/creations/original/victim.webp`;
    const suffixes = referenceSuffixes("creations", "original/victim.webp");

    expect(matchesUnderGuard(stored, suffixes)).toBe(false);
  });

  it("cannot be defeated by a '?' in an object name, because such a name cannot exist", () => {
    // Measured, because the intuitive answer is wrong twice over. encodeURI
    // does NOT escape '?', so referenceSuffixes emits it raw rather than as
    // %3F - which would make a URL for such a name ambiguous. What rescues the
    // split is Supabase itself: it truncates an uploaded object name at the
    // first '?' (uploading `…-what?.webp` stored `…-what`), so a stored name
    // containing one is unreachable. The first raw '?' in a stored URL is
    // therefore always the query delimiter.
    const { encoded } = referenceSuffixes("creations", "original/what?.webp");

    expect(encoded).toBe("/creations/original/what?.webp"); // NOT %3F
  });
});

describe("SEC-8.4B — parseStorageUrl already ignored the query string", () => {
  it("parses a URL with a cache-buster into the same bucket and path", () => {
    // Worth pinning rather than assuming: this half was already correct,
    // because `new URL(...).pathname` excludes the query. The defect was only
    // ever in the SQL comparison against the raw column.
    expect(parseStorageUrl(`${HOST}/avatars/f60f71b5.jpg?v=1784034159601`)).toEqual({
      bucket: "avatars",
      path: "f60f71b5.jpg",
    });

    expect(parseStorageUrl(`${HOST}/creations/original/abc.webp?v=1&x=2`)).toEqual({
      bucket: "creations",
      path: "original/abc.webp",
    });
  });
});

describe("SEC-8.4B — the emitted SQL", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.query.mockResolvedValue({ rows: [{ referenced: false }] });
  });

  it("strips the query string from every URL column it compares", async () => {
    await isReferenced({ bucket: "creations", path: "original/abc.webp" });

    const [sql] = db.query.mock.calls[0];
    for (const column of [
      "image_url",
      "thumbnail_url",
      "cover_image",
      "cover_image_thumbnail",
      "avatar_url",
    ]) {
      expect(sql).toMatch(new RegExp(`split_part\\(${column}, '\\?', 1\\)`));
    }
  });

  it("compares no column against the raw stored value any more", async () => {
    // A single column left unstripped is a column that silently drops
    // references, so this asserts the absence of the old shape outright.
    await isReferenced({ bucket: "creations", path: "original/abc.webp" });

    const [sql] = db.query.mock.calls[0];
    expect(sql).not.toMatch(/right\(\s*(image_url|thumbnail_url|cover_image|cover_image_thumbnail|avatar_url)\s*,/);
  });

  it("leaves the parameters exactly as SEC-8.4 built them", async () => {
    // The fix changes how the column is read, never what it is compared to.
    await isReferenced({ bucket: "creations", path: "original/my file.webp" });

    const [, params] = db.query.mock.calls[0];
    expect(params).toEqual([
      "/creations/original/my file.webp",
      "/creations/original/my file.webp".length,
      "/creations/original/my%20file.webp",
      "/creations/original/my%20file.webp".length,
    ]);
  });
});
