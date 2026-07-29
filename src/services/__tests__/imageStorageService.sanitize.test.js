"use strict";

/**
 * SEC-8.3 (leg A) — every stored original is sanitised on the way in.
 *
 * The storage layer is the choke point every upload path goes through, so
 * these tests assert the bytes that reach Supabase, not that a helper was
 * called: a test that only checks the call would still pass if the sanitised
 * result were computed and then thrown away.
 */

const sharp = require("sharp");

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

const imageStorageService = require("../imageStorageService");

const EXIF_MARKER = Buffer.from("Exif\x00\x00", "latin1");

async function jpegWithExif() {
  return sharp({ create: { width: 40, height: 20, channels: 3, background: "#aa3366" } })
    .withExif({
      IFD0: { Software: "StyliTestSoftware" },
      GPS: { GPSLatitudeRef: "N", GPSLatitude: "51/1 30/1 0/1" },
    })
    .jpeg()
    .toBuffer();
}

/** The buffer handed to Supabase for the `original/` object. */
function uploadedOriginal() {
  const call = mockUpload.mock.calls.find(([path]) => path.startsWith("original/"));
  return call && call[1];
}

describe("SEC-8.3 — uploadOriginalWithThumbnail sanitises the original", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUpload.mockResolvedValue({ error: null });
    mockGetPublicUrl.mockReturnValue({ data: { publicUrl: "https://example.test/object" } });
  });

  it("strips EXIF from the stored original", async () => {
    const input = await jpegWithExif();
    expect(input.indexOf(EXIF_MARKER)).not.toBe(-1);

    await imageStorageService.uploadOriginalWithThumbnail({
      buffer: input,
      mimeType: "image/jpeg",
      bucket: "style-images",
    });

    const stored = uploadedOriginal();
    expect(stored).toBeDefined();
    expect(stored.indexOf(EXIF_MARKER)).toBe(-1);
    expect((await sharp(stored).metadata()).exif).toBeUndefined();
  });

  it("does not leak the GPS or device tags into storage", async () => {
    await imageStorageService.uploadOriginalWithThumbnail({
      buffer: await jpegWithExif(),
      mimeType: "image/jpeg",
      bucket: "style-images",
    });

    expect(uploadedOriginal().includes(Buffer.from("StyliTestSoftware", "latin1"))).toBe(false);
  });

  it("still stores a usable image of the same dimensions", async () => {
    await imageStorageService.uploadOriginalWithThumbnail({
      buffer: await jpegWithExif(),
      mimeType: "image/jpeg",
      bucket: "style-images",
    });

    const meta = await sharp(uploadedOriginal()).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBe(40);
    expect(meta.height).toBe(20);
  });

  it("uploads provider output byte-for-byte, without a needless re-encode", async () => {
    // Stability/Gemini output carries no user metadata; re-encoding it would
    // cost quality on the product's main asset for no privacy gain.
    const providerOutput = await sharp({
      create: { width: 32, height: 32, channels: 3, background: "#404040" },
    })
      .webp()
      .toBuffer();

    await imageStorageService.uploadOriginalWithThumbnail({
      buffer: providerOutput,
      mimeType: "image/webp",
      bucket: "creations",
    });

    expect(uploadedOriginal().equals(providerOutput)).toBe(true);
  });

  it("thumbnails from the sanitised bytes, so both objects share one orientation", async () => {
    // Orientation 6 means the original is stored rotated; a thumbnail built
    // from the pre-sanitised buffer would disagree with it.
    const rotated = await sharp({ create: { width: 100, height: 50, channels: 3, background: "#0f0" } })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();

    await imageStorageService.uploadOriginalWithThumbnail({
      buffer: rotated,
      mimeType: "image/jpeg",
      bucket: "style-images",
    });

    const storedMeta = await sharp(uploadedOriginal()).metadata();
    expect(storedMeta.width).toBe(50);
    expect(storedMeta.height).toBe(100);

    const thumbCall = mockUpload.mock.calls.find(([path]) => path.startsWith("thumbs/"));
    expect(thumbCall).toBeDefined();
    expect((await sharp(thumbCall[1]).metadata()).format).toBe("webp");
  });

  it("fails closed: nothing is uploaded when the image cannot be sanitised", async () => {
    await expect(
      imageStorageService.uploadOriginalWithThumbnail({
        buffer: Buffer.from("not an image at all"),
        mimeType: "image/jpeg",
        bucket: "style-images",
      })
    ).rejects.toThrow(/Unreadable image/);

    expect(mockUpload).not.toHaveBeenCalled();
  });
});
