"use strict";

/**
 * R-2 phase 6 — which avatar objects may be deleted.
 *
 * Nothing has ever deleted from the `avatars` bucket, and three of the four
 * objects in production belonged to users that no longer exist. This is the
 * predicate that reclaims those without ever taking a live one.
 *
 * Every test here is about refusing to delete. That asymmetry is deliberate:
 * keeping an orphan costs a few KiB, and deleting a live avatar destroys
 * something the user cannot recover. The classifier is written so that every
 * uncertain answer is "keep".
 */

jest.mock("../../config/db", () => ({ query: jest.fn() }));
jest.mock("../../config/supabase", () => ({ storage: { from: jest.fn() } }));

const mockIsReferenced = jest.fn();
jest.mock("../../services/creationAssetCleanup", () => ({
  isReferenced: (...args) => mockIsReferenced(...args),
  parseStorageUrl: jest.requireActual("../../services/creationAssetCleanup").parseStorageUrl,
  DELETABLE_BUCKETS: jest.requireActual("../../services/creationAssetCleanup").DELETABLE_BUCKETS,
}));

const db = require("../../config/db");
const { classifyAvatarObject, ownerIdFromObjectName } = require("../reconcileOrphanedAvatars");
const { DELETABLE_BUCKETS } = require("../../services/creationAssetCleanup");

const OWNER = "f60f71b5-be64-43d4-b747-e2dadd8787f7";
const NAME = `${OWNER}.jpg`;
const NOW = Date.parse("2026-07-30T00:00:00.000Z");
const OLD = "2026-07-01T00:00:00.000Z"; // ~29 days before NOW
const FRESH = "2026-07-29T23:00:00.000Z"; // 1 hour before NOW

/** No user row -> the owner no longer exists. */
function ownerMissing() {
  db.query.mockResolvedValue({ rows: [] });
}
function ownerPresent() {
  db.query.mockResolvedValue({ rows: [{ "?column?": 1 }] });
}

function classify(overrides = {}) {
  return classifyAvatarObject({
    name: NAME,
    createdAt: OLD,
    minAgeHours: 24,
    now: NOW,
    ...overrides,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsReferenced.mockResolvedValue(false);
  ownerMissing();
});

describe("an object is an orphan only when everything says so", () => {
  it("deletes an unreferenced avatar whose owner no longer exists", async () => {
    const result = await classify();

    expect(result.verdict).toBe("orphan");
    expect(result.ownerId).toBe(OWNER);
  });

  it("keeps an avatar that a row still references", async () => {
    mockIsReferenced.mockResolvedValue(true);

    expect((await classify()).verdict).toBe("keep");
  });

  it("keeps an avatar whose owner still exists, even if unreferenced", async () => {
    // The second, independent check. A live user whose avatar_url is null or
    // momentarily mid-write would otherwise look exactly like an orphan.
    ownerPresent();

    const result = await classify();

    expect(result.verdict).toBe("keep");
    expect(result.reason).toBe("owner_exists");
  });

  it("checks the reference guard against the avatars bucket and the object name", async () => {
    await classify();

    expect(mockIsReferenced).toHaveBeenCalledWith({ bucket: "avatars", path: NAME });
  });

  it("looks the owner up by the id embedded in the object name", async () => {
    await classify();

    expect(db.query.mock.calls[0][1]).toEqual([OWNER]);
  });
});

describe("the age guard", () => {
  it("keeps an object younger than the minimum age", async () => {
    // An avatar object is written before profiles.avatar_url is updated, so an
    // upload in flight is briefly indistinguishable from an orphan.
    const result = await classify({ createdAt: FRESH });

    expect(result.verdict).toBe("keep");
    expect(result.reason).toBe("too_new");
  });

  it("does not even consult the database for something too new", async () => {
    await classify({ createdAt: FRESH });

    expect(mockIsReferenced).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });

  it("keeps an object with an unparseable timestamp", async () => {
    // An unreadable age is not an old age.
    const result = await classify({ createdAt: "not-a-date" });

    expect(result.verdict).toBe("keep");
    expect(result.reason).toBe("too_new");
  });
});

describe("names", () => {
  it("keeps anything that is not a <uuid>.jpg", async () => {
    // An unexpected name means an assumption changed. The safe response is to
    // leave it alone, not to guess.
    for (const name of ["thumbs/", "readme.txt", "not-a-uuid.jpg", `${OWNER}.png`, ""]) {
      const result = await classify({ name });
      expect(result.verdict).toBe("keep");
      expect(result.reason).toBe("unrecognized_name");
    }
  });

  it("extracts the owner id from a well-formed name", () => {
    expect(ownerIdFromObjectName(NAME)).toBe(OWNER);
  });

  it("returns null rather than a partial id for a malformed name", () => {
    expect(ownerIdFromObjectName(`${OWNER}.jpg.bak`)).toBeNull();
    expect(ownerIdFromObjectName(`../../${OWNER}.jpg`)).toBeNull();
    expect(ownerIdFromObjectName("")).toBeNull();
  });
});

describe("the bucket allow-list is deliberately untouched", () => {
  it("avatars is still NOT deletable through creationAssetCleanup", async () => {
    // This is the point of the script existing separately. An avatar's object
    // name IS its owner's user id, so putting the bucket on that list would
    // let a crafted migrateCreations row plus a delete become a targeted
    // erasure of someone else's photo. Reconciliation runs from an operator's
    // shell; nothing on a request path can reach it.
    expect(DELETABLE_BUCKETS.has("avatars")).toBe(false);
    expect(DELETABLE_BUCKETS.has("creations")).toBe(true);
    expect(DELETABLE_BUCKETS.has("style-images")).toBe(true);
  });
});
