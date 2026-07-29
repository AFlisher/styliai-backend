"use strict";

/**
 * SEC-8.1B-2 (step 1) — admin previews never reach storage.
 *
 * The user-facing generation and the admin prompt-test tool share one service
 * call, and the tool used to keep its output: two objects per click written
 * into `creations` with no row that could ever reference them. That is the
 * only recurring orphan source SEC-8.4 found, and it puts admin test renders
 * in the bucket that is about to become private user content.
 *
 * Both directions are asserted. "Preview does not persist" alone would still
 * pass if persistence broke everywhere, which would silently discard real
 * users' generated images.
 */

jest.mock("../imageStorageService", () => ({
  uploadOriginalWithThumbnail: jest.fn(),
}));

jest.mock("../../config/generationTimeouts", () => ({
  generationTimeouts: { providerMs: 60000, downloadMs: 10000 },
}));

const imageStorageService = require("../imageStorageService");
const stabilityService = require("../stabilityService");

const IMAGE_BYTES = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x01, 0x02, 0x03, 0x04]);

function mockStabilityResponse() {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: {
      get: (name) => (name === "seed" ? "12345" : name === "finish-reason" ? "SUCCESS" : null),
    },
    arrayBuffer: async () => IMAGE_BYTES.buffer.slice(
      IMAGE_BYTES.byteOffset,
      IMAGE_BYTES.byteOffset + IMAGE_BYTES.byteLength
    ),
  });
}

describe("SEC-8.1B-2 — stabilityService persistence", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.STABILITY_API_KEY = "test-key";
    mockStabilityResponse();
    imageStorageService.uploadOriginalWithThumbnail.mockResolvedValue({
      url: "https://x.test/storage/v1/object/public/creations/original/a.webp",
      thumbnailUrl: "https://x.test/storage/v1/object/public/creations/thumbs/a.webp",
    });
  });

  describe("persist: false (the admin preview)", () => {
    it("writes nothing to storage", async () => {
      await stabilityService.generateImage({ prompt: "a test prompt", persist: false });

      expect(imageStorageService.uploadOriginalWithThumbnail).not.toHaveBeenCalled();
    });

    it("returns the image inline as a webp data URI", async () => {
      const result = await stabilityService.generateImage({
        prompt: "a test prompt",
        persist: false,
      });

      expect(result.imageUrl).toBe(`data:image/webp;base64,${IMAGE_BYTES.toString("base64")}`);
      expect(result.thumbnailUrl).toBeNull();
    });

    it("returns something an <img> can render, so the dashboard needs no change", async () => {
      const { imageUrl } = await stabilityService.generateImage({
        prompt: "a test prompt",
        persist: false,
      });

      expect(imageUrl.startsWith("data:image/")).toBe(true);
      expect(imageUrl).not.toContain("/storage/v1/object/public/");
    });

    it("still reports the provider metadata", async () => {
      const result = await stabilityService.generateImage({
        prompt: "a test prompt",
        persist: false,
      });

      expect(result.seed).toBe("12345");
      expect(result.finishReason).toBe("SUCCESS");
    });
  });

  describe("persist defaults to true (the real user path)", () => {
    it("stores the image when persist is not passed", async () => {
      const result = await stabilityService.generateImage({ prompt: "a real generation" });

      expect(imageStorageService.uploadOriginalWithThumbnail).toHaveBeenCalledTimes(1);
      expect(result.imageUrl).toContain("/storage/v1/object/public/creations/");
    });

    it("stores into the creations bucket, unchanged by this work", async () => {
      await stabilityService.generateImage({ prompt: "a real generation" });

      const [args] = imageStorageService.uploadOriginalWithThumbnail.mock.calls[0];
      expect(args.bucket).toBe("creations");
    });

    it("returns a stored URL, never a data URI", async () => {
      const { imageUrl } = await stabilityService.generateImage({ prompt: "a real generation" });

      expect(imageUrl.startsWith("data:")).toBe(false);
    });
  });
});
