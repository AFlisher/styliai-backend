"use strict";

/**
 * SEC-8.1B-1 — generated user images are stored in `creations`, never in the
 * admin catalog bucket.
 *
 * This file exists for one reason: the separation is a single constant, and
 * without an assertion on it the constant can be flipped back with the entire
 * suite still green. Nothing else in the codebase would notice — erasure,
 * reconciliation and the thumbnail backfill all read the bucket from the
 * stored URL rather than from a constant, so they keep working either way and
 * would not fail.
 *
 * The invariant is asserted in both directions on purpose. "Called with
 * creations" alone would still pass if a second upload also went to
 * `style-images`, and "never called with style-images" alone would pass if
 * the upload stopped happening at all.
 */

const mockGenerateImage = jest.fn();

jest.mock("../geminiProvider", () =>
  jest.fn().mockImplementation(() => ({ generateImage: mockGenerateImage }))
);
jest.mock("../falProvider", () =>
  jest.fn().mockImplementation(() => ({ generateImage: mockGenerateImage }))
);

jest.mock("../../../models/styleModel", () => ({
  getStyleById: jest.fn(),
}));

jest.mock("../../imageStorageService", () => ({
  uploadOriginalWithThumbnail: jest.fn(),
}));

// The sanitiser is real sharp elsewhere; here the source bytes are irrelevant
// to what is being asserted, so it is stubbed to keep this file about buckets.
jest.mock("../../../utils/imageMetadataSanitizer", () => ({
  sanitizeImageBuffer: jest.fn(async (buffer) => ({
    buffer,
    format: "jpeg",
    stripped: false,
  })),
}));

const styleModel = require("../../../models/styleModel");
const imageStorageService = require("../../imageStorageService");
const generationService = require("../generationService");

const CATALOG_BUCKET = "style-images";
const USER_CONTENT_BUCKET = "creations";

const asFile = () => ({ buffer: Buffer.from("source-photo"), mimetype: "image/jpeg" });

/** Every bucket the service asked storage to write to during a call. */
function bucketsWrittenTo() {
  return imageStorageService.uploadOriginalWithThumbnail.mock.calls.map(([args]) => args.bucket);
}

describe("SEC-8.1B-1 — generation output goes to the user-content bucket", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.IMAGE_PROVIDER = "gemini";
    styleModel.getStyleById.mockResolvedValue({ id: 1, isEnabled: true, prompt: "a prompt" });
    mockGenerateImage.mockResolvedValue(Buffer.from("generated-output"));
    imageStorageService.uploadOriginalWithThumbnail.mockResolvedValue({
      url: "https://example.test/storage/v1/object/public/creations/original/x.jpg",
      thumbnailUrl: "https://example.test/storage/v1/object/public/creations/thumbs/x.webp",
    });
  });

  it("uploads to creations", async () => {
    await generationService.generate(asFile(), 1, "prompt");

    expect(imageStorageService.uploadOriginalWithThumbnail).toHaveBeenCalledTimes(1);
    expect(imageStorageService.uploadOriginalWithThumbnail).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: USER_CONTENT_BUCKET })
    );
  });

  it("never uploads to the admin catalog bucket", async () => {
    await generationService.generate(asFile(), 1, "prompt");

    expect(bucketsWrittenTo()).not.toContain(CATALOG_BUCKET);
    expect(bucketsWrittenTo()).toEqual([USER_CONTENT_BUCKET]);
  });

  it("holds for a multi-image style too", async () => {
    // Multi-image styles take a different path into the provider call; the
    // destination bucket must not depend on it.
    await generationService.generate([asFile(), asFile(), asFile()], 1, "prompt");

    expect(bucketsWrittenTo()).toEqual([USER_CONTENT_BUCKET]);
  });

  it("holds regardless of which provider is configured", async () => {
    process.env.IMAGE_PROVIDER = "fal";

    await generationService.generate(asFile(), 1, "prompt");

    expect(bucketsWrittenTo()).toEqual([USER_CONTENT_BUCKET]);
  });

  it("still returns the URLs storage reported, unchanged", async () => {
    // The bucket moved; the response contract did not. The client stores
    // whatever comes back, so a change in shape here would be a client-visible
    // regression rather than a storage one.
    const result = await generationService.generate(asFile(), 1, "prompt");

    expect(result).toEqual({
      imageUrl: "https://example.test/storage/v1/object/public/creations/original/x.jpg",
      thumbnailUrl: "https://example.test/storage/v1/object/public/creations/thumbs/x.webp",
    });
  });

  it("keeps the original/thumbs layout decision inside imageStorageService", async () => {
    // Separation must not smuggle a path prefix into the caller: the layout is
    // imageStorageService's contract, and SEC-8.1A's erasure depends on it
    // staying that way.
    await generationService.generate(asFile(), 1, "prompt");

    const [args] = imageStorageService.uploadOriginalWithThumbnail.mock.calls[0];
    expect(args).not.toHaveProperty("folder");
    expect(args).not.toHaveProperty("path");
    expect(args.baseName).toBeUndefined();
  });
});
