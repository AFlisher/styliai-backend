"use strict";

/**
 * SEC-8.1B-2 (step 4) — the `creations` bucket is private.
 *
 * The flip itself is storage configuration, not code, so what needs pinning is
 * the set of assumptions that quietly became load-bearing the moment it
 * happened.
 *
 * The important and counter-intuitive one: a private bucket's stored URL still
 * contains the literal string `/storage/v1/object/public/`. `getPublicUrl` is a
 * pure string builder that never consults bucket visibility, so the column
 * keeps that shape - and three separate subsystems parse that exact marker to
 * find the bucket and path:
 *
 *   - the delivery endpoint, to know what to sign,
 *   - SEC-8.1A erasure, to know what to delete,
 *   - the SEC-8.4 reconciler, to decide what is an orphan.
 *
 * The word "public" in a private bucket's URL now reads like a leftover, and
 * "tidying" it would break all three at once - erasure would silently stop
 * deleting, and the reconciler would reclassify live objects as orphans and
 * remove them. These tests make that a test failure rather than a discovery.
 */

const mockUpload = jest.fn();
const mockGetPublicUrl = jest.fn();

jest.mock("../../config/supabase", () => ({
  storage: {
    from: jest.fn(() => ({
      upload: mockUpload,
      getPublicUrl: mockGetPublicUrl,
    })),
  },
}));

jest.mock("../../config/db", () => ({ query: jest.fn() }));

const sharp = require("sharp");
const imageStorageService = require("../imageStorageService");
const creationAssetCleanup = require("../creationAssetCleanup");

const PROJECT = "https://proj.supabase.co";

// Real bytes: the upload path runs SEC-8.3's sanitizer, which correctly refuses
// anything it cannot decode.
let imageBytes;
beforeAll(async () => {
  imageBytes = await sharp({
    create: { width: 8, height: 8, channels: 3, background: "#123456" },
  })
    .webp()
    .toBuffer();
});

beforeEach(() => {
  jest.clearAllMocks();
  mockUpload.mockResolvedValue({ error: null });
  // Exactly what the real getPublicUrl returns for a PRIVATE bucket: the
  // "public" path segment is part of the URL template, not a statement about
  // visibility.
  mockGetPublicUrl.mockImplementation((path) => ({
    data: { publicUrl: `${PROJECT}/storage/v1/object/public/creations/${path}` },
  }));
});

describe("SEC-8.1B-2 step 4 — what a private bucket still stores", () => {
  it("stores a URL the erasure/reconciliation parser can still resolve", async () => {
    // The cross-module invariant. If what we store ever stops being parseable,
    // SEC-8.1A erasure and the SEC-8.4 reconciler both lose the ability to
    // identify the object, in opposite and equally bad directions.
    const result = await imageStorageService.uploadOriginalWithThumbnail({
      buffer: imageBytes,
      mimeType: "image/webp",
      bucket: "creations",
      baseName: "abc",
    });

    const parsed = creationAssetCleanup.parseStorageUrl(result.url);

    expect(parsed).not.toBeNull();
    expect(parsed).toEqual({ bucket: "creations", path: "original/abc.webp" });
  });

  it("keeps the /object/public/ marker even though the bucket is private", () => {
    // Documenting the trap explicitly: this segment is a URL template, not a
    // claim about access. Removing it because it "looks wrong" for a private
    // bucket would break signing, erasure and reconciliation together.
    const { data } = require("../../config/supabase").storage
      .from("creations")
      .getPublicUrl("original/abc.webp");

    expect(data.publicUrl).toContain("/storage/v1/object/public/");
    expect(creationAssetCleanup.parseStorageUrl(data.publicUrl)).toEqual({
      bucket: "creations",
      path: "original/abc.webp",
    });
  });

  it("resolves the bucket from the URL, so creations and style-images both work", () => {
    // Creations legitimately exist in both buckets historically, and only one
    // of them is private. The parser must not assume either.
    expect(
      creationAssetCleanup.parseStorageUrl(
        `${PROJECT}/storage/v1/object/public/creations/original/abc.webp`
      )
    ).toEqual({ bucket: "creations", path: "original/abc.webp" });

    expect(
      creationAssetCleanup.parseStorageUrl(
        `${PROJECT}/storage/v1/object/public/style-images/original/abc.webp`
      )
    ).toEqual({ bucket: "style-images", path: "original/abc.webp" });
  });

  it("still treats creations as a bucket objects may be deleted from", () => {
    // Privacy is not retention. The flip must not have made erasure a no-op.
    expect(creationAssetCleanup.DELETABLE_BUCKETS.has("creations")).toBe(true);
  });

  it("does not store a signed URL", () => {
    // A signature in the column would expire, and would make the stored value
    // unparseable by the marker above. Signing belongs to the response, not to
    // the database.
    const stored = `${PROJECT}/storage/v1/object/public/creations/original/abc.webp`;

    expect(stored).not.toContain("/object/sign/");
    expect(stored).not.toContain("token=");
  });
});
