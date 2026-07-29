"use strict";

/**
 * SEC-8.3 (leg B) — the user's source photo is stripped before it reaches a
 * third-party provider.
 *
 * This is the leg that matters most: with IMAGE_PROVIDER=fal the source image
 * is uploaded to fal's CDN under a public URL we cannot delete, so anything
 * still embedded in it has left our control permanently. The assertion is
 * therefore on the bytes the provider receives.
 */

const sharp = require("sharp");

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

const styleModel = require("../../../models/styleModel");
const imageStorageService = require("../../imageStorageService");
const generationService = require("../generationService");

const EXIF_MARKER = Buffer.from("Exif\x00\x00", "latin1");

async function photoWithExif(background = "#557799") {
  return sharp({ create: { width: 48, height: 24, channels: 3, background } })
    .withExif({
      IFD0: { Software: "StyliTestSoftware", Model: "StyliTestHandset" },
      GPS: {
        GPSLatitudeRef: "N",
        GPSLatitude: "51/1 30/1 0/1",
        GPSLongitudeRef: "W",
        GPSLongitude: "0/1 7/1 0/1",
      },
    })
    .jpeg()
    .toBuffer();
}

const asFile = (buffer) => ({ buffer, mimetype: "image/jpeg" });

describe("SEC-8.3 — generationService strips metadata before the provider call", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.IMAGE_PROVIDER = "gemini";
    styleModel.getStyleById.mockResolvedValue({ id: 1, isEnabled: true, prompt: "a prompt" });
    mockGenerateImage.mockResolvedValue(Buffer.from("generated-output"));
    imageStorageService.uploadOriginalWithThumbnail.mockResolvedValue({
      url: "https://example.test/original",
      thumbnailUrl: "https://example.test/thumb",
    });
  });

  it("hands the provider a buffer with no EXIF block", async () => {
    const source = await photoWithExif();
    expect(source.indexOf(EXIF_MARKER)).not.toBe(-1);

    await generationService.generate(asFile(source), 1, "prompt");

    const { imageBuffer } = mockGenerateImage.mock.calls[0][0];
    expect(imageBuffer.indexOf(EXIF_MARKER)).toBe(-1);
    expect((await sharp(imageBuffer).metadata()).exif).toBeUndefined();
  });

  it("does not send GPS or device identifiers to the provider", async () => {
    await generationService.generate(asFile(await photoWithExif()), 1, "prompt");

    const { imageBuffer } = mockGenerateImage.mock.calls[0][0];
    expect(imageBuffer.includes(Buffer.from("StyliTestHandset", "latin1"))).toBe(false);
    expect(imageBuffer.includes(Buffer.from("StyliTestSoftware", "latin1"))).toBe(false);
  });

  it("strips every image of a multi-image style, not just the first", async () => {
    const files = [
      asFile(await photoWithExif("#111111")),
      asFile(await photoWithExif("#222222")),
      asFile(await photoWithExif("#333333")),
    ];

    await generationService.generate(files, 1, "prompt");

    const { images } = mockGenerateImage.mock.calls[0][0];
    expect(images).toHaveLength(3);
    for (const image of images) {
      expect(image.buffer.indexOf(EXIF_MARKER)).toBe(-1);
      expect(image.mimeType).toBe("image/jpeg");
    }
  });

  it("keeps imageBuffer and images[0] the same sanitised bytes", async () => {
    await generationService.generate(asFile(await photoWithExif()), 1, "prompt");

    const { imageBuffer, images } = mockGenerateImage.mock.calls[0][0];
    expect(images[0].buffer.equals(imageBuffer)).toBe(true);
  });

  it("still sends a usable image", async () => {
    await generationService.generate(asFile(await photoWithExif()), 1, "prompt");

    const { imageBuffer } = mockGenerateImage.mock.calls[0][0];
    const meta = await sharp(imageBuffer).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBe(48);
    expect(meta.height).toBe(24);
  });

  it("fails closed: an unsanitisable image never reaches the provider", async () => {
    await expect(
      generationService.generate(asFile(Buffer.from("not an image")), 1, "prompt")
    ).rejects.toThrow(/Unreadable image/);

    // The controller treats a throw from generate() as a failed generation and
    // refunds the user, so failing here is safe as well as correct.
    expect(mockGenerateImage).not.toHaveBeenCalled();
  });

  it("sanitises before the provider is reached under fal too", async () => {
    process.env.IMAGE_PROVIDER = "fal";

    await generationService.generate(asFile(await photoWithExif()), 1, "prompt");

    const { imageBuffer } = mockGenerateImage.mock.calls[0][0];
    expect(imageBuffer.indexOf(EXIF_MARKER)).toBe(-1);
  });
});
