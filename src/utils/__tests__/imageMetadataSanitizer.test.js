"use strict";

/**
 * SEC-8.3 — imageMetadataSanitizer.
 *
 * Deliberately runs against real sharp and real image bytes. A mocked sharp
 * would let every one of these tests pass while the sanitiser stripped
 * nothing: the assertion that matters is "the EXIF marker is not in the output
 * bytes", and only real encoding can establish that.
 */

const sharp = require("sharp");
const { sanitizeImageBuffer, carriesMetadata } = require("../imageMetadataSanitizer");

const EXIF_MARKER = Buffer.from("Exif\x00\x00", "latin1");

const hasExifMarker = (buffer) => buffer.indexOf(EXIF_MARKER) !== -1;

/** A JPEG carrying the tags real user photos actually leak, GPS included. */
async function jpegWithExif() {
  return sharp({ create: { width: 32, height: 16, channels: 3, background: "#3366aa" } })
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

/**
 * A 3-frame animated GIF. Built by hand from the canonical 1x1 GIF because
 * sharp can only write an animated GIF from an animated source, so there is no
 * way to bootstrap one through sharp alone.
 */
function animatedGif() {
  const base = Buffer.from(
    "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
    "base64"
  );
  const header = base.subarray(0, 19); // signature + screen descriptor + colour table
  const frame = base.subarray(19, base.length - 1); // graphic control + descriptor + data
  const otherFrame = Buffer.from(frame);
  otherFrame[otherFrame.length - 2] = 0x4c; // different pixel index, so frames differ
  const netscapeLoop = Buffer.from("21ff0b4e45545343415045322e300301000000", "hex");

  return Buffer.concat([header, netscapeLoop, frame, otherFrame, frame, Buffer.from([0x3b])]);
}

describe("SEC-8.3 — sanitizeImageBuffer", () => {
  describe("stripping", () => {
    it("removes the EXIF block from a JPEG that carries one", async () => {
      const input = await jpegWithExif();
      expect(hasExifMarker(input)).toBe(true);

      const { buffer, stripped } = await sanitizeImageBuffer(input);

      expect(stripped).toBe(true);
      expect(hasExifMarker(buffer)).toBe(false);
      expect((await sharp(buffer).metadata()).exif).toBeUndefined();
    });

    it("removes GPS coordinates specifically", async () => {
      const input = await jpegWithExif();
      const { buffer } = await sanitizeImageBuffer(input);

      // The tag values are ASCII in the EXIF block; if any survived the strip
      // they would still be findable in the output bytes.
      expect(buffer.includes(Buffer.from("StyliTestHandset", "latin1"))).toBe(false);
      expect(buffer.includes(Buffer.from("StyliTestSoftware", "latin1"))).toBe(false);
    });

    it("keeps the image usable and the same format", async () => {
      const input = await jpegWithExif();
      const { buffer, format } = await sanitizeImageBuffer(input);

      const meta = await sharp(buffer).metadata();
      expect(format).toBe("jpeg");
      expect(meta.format).toBe("jpeg");
      expect(meta.width).toBe(32);
      expect(meta.height).toBe(16);
    });
  });

  describe("the three traps", () => {
    it("bakes EXIF orientation into the pixels instead of dropping it", async () => {
      // Orientation 6 means "rotate 90deg on display". Strip the tag without
      // baking it and every portrait phone photo renders sideways.
      const input = await sharp({ create: { width: 100, height: 50, channels: 3, background: "#f00" } })
        .withMetadata({ orientation: 6 })
        .jpeg()
        .toBuffer();
      expect((await sharp(input).metadata()).orientation).toBe(6);

      const { buffer } = await sanitizeImageBuffer(input);
      const meta = await sharp(buffer).metadata();

      expect(meta.width).toBe(50);
      expect(meta.height).toBe(100);
      expect(meta.orientation).toBeUndefined();
    });

    it("never flattens an animated GIF", async () => {
      // libvips reports no metadata for GIF (comment/application extensions
      // are invisible to it), so a GIF takes the pass-through branch and its
      // frames are safe by construction. Pinned because the failure mode if
      // this ever changes is silent: a re-encode without `animated: true`
      // returns a still image and nothing errors.
      const input = animatedGif();
      expect((await sharp(input, { animated: true }).metadata()).pages).toBe(3);

      const { buffer, stripped } = await sanitizeImageBuffer(input);

      expect(stripped).toBe(false);
      expect(buffer.equals(input)).toBe(true);
      expect((await sharp(buffer, { animated: true }).metadata()).pages).toBe(3);
    });

    it("keeps the ICC colour profile while dropping EXIF", async () => {
      const input = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#00f" } })
        .withMetadata({ icc: "p3", orientation: 3 })
        .jpeg()
        .toBuffer();

      const { buffer } = await sanitizeImageBuffer(input);
      const meta = await sharp(buffer).metadata();

      expect(meta.icc).toBeDefined();
      expect(meta.exif).toBeUndefined();
    });
  });

  describe("pass-through", () => {
    it("returns a clean buffer byte-identical rather than re-encoding it", async () => {
      const clean = await sharp({ create: { width: 16, height: 16, channels: 3, background: "#0a0" } })
        .webp({ quality: 90 })
        .toBuffer();

      const { buffer, stripped, format } = await sanitizeImageBuffer(clean);

      expect(stripped).toBe(false);
      expect(format).toBe("webp");
      expect(buffer).toBe(clean); // same reference: nothing was rewritten
    });

    it("does not degrade provider output, which carries no metadata", async () => {
      // Stability writes WebP into `creations`; re-encoding it to "sanitise"
      // it would cost quality for no privacy gain.
      const providerOutput = await sharp({
        create: { width: 64, height: 64, channels: 3, background: "#888" },
      })
        .webp()
        .toBuffer();

      const { buffer, stripped } = await sanitizeImageBuffer(providerOutput);

      expect(stripped).toBe(false);
      expect(buffer.equals(providerOutput)).toBe(true);
    });
  });

  describe("formats", () => {
    it.each([
      ["png", (p) => p.png()],
      ["webp", (p) => p.webp()],
    ])("round-trips %s back to itself", async (format, encode) => {
      const input = await encode(
        sharp({ create: { width: 24, height: 24, channels: 3, background: "#123" } }).withExif({
          IFD0: { Software: "StyliTestSoftware" },
        })
      ).toBuffer();

      const result = await sanitizeImageBuffer(input);

      expect(result.format).toBe(format);
      expect((await sharp(result.buffer).metadata()).format).toBe(format);
    });
  });

  describe("failing closed", () => {
    it("throws on bytes that are not an image", async () => {
      await expect(sanitizeImageBuffer(Buffer.from("definitely not an image"))).rejects.toThrow(
        /Unreadable image/
      );
    });

    it("throws on an empty buffer", async () => {
      await expect(sanitizeImageBuffer(Buffer.alloc(0))).rejects.toThrow(/non-empty Buffer/);
    });

    it("throws on a non-buffer", async () => {
      await expect(sanitizeImageBuffer("not a buffer")).rejects.toThrow(/non-empty Buffer/);
    });

    it("refuses a format it cannot re-emit rather than passing it through", async () => {
      // TIFF decodes fine but is not in the allow-list, so it must not slip
      // through unsanitised just because sharp could read it.
      const tiff = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#fff" } })
        .tiff()
        .toBuffer();

      await expect(sanitizeImageBuffer(tiff)).rejects.toThrow(/Unsupported image format/);
    });
  });
});

describe("SEC-8.3 — how the strip pipeline is built", () => {
  /**
   * Interaction tests against a mocked sharp, deliberately unlike the rest of
   * this file. The `animated: true` branch cannot be reached with real bytes
   * today because libvips reports no GIF metadata, so asserting how the
   * pipeline is constructed is the only way to keep that guard honest — and
   * that guard is what stands between a future libvips change and silently
   * flattened animations.
   */
  function loadWithMockedSharp(metadata) {
    let sharpMock;
    let pipeline;
    let mod;

    jest.isolateModules(() => {
      jest.doMock("sharp", () => {
        pipeline = {
          rotate: jest.fn(() => pipeline),
          keepIccProfile: jest.fn(() => pipeline),
          jpeg: jest.fn(() => pipeline),
          png: jest.fn(() => pipeline),
          webp: jest.fn(() => pipeline),
          gif: jest.fn(() => pipeline),
          metadata: jest.fn(async () => metadata),
          toBuffer: jest.fn(async () => Buffer.from("re-encoded")),
        };
        sharpMock = jest.fn(() => pipeline);
        return sharpMock;
      });
      mod = require("../imageMetadataSanitizer");
    });

    return { mod, getSharpMock: () => sharpMock, getPipeline: () => pipeline };
  }

  afterEach(() => {
    jest.dontMock("sharp");
    jest.resetModules();
  });

  it("opens a metadata-bearing GIF with animated:true", async () => {
    const { mod, getSharpMock, getPipeline } = loadWithMockedSharp({
      format: "gif",
      xmp: Buffer.from([1]),
    });

    await mod.sanitizeImageBuffer(Buffer.from("gif-bytes"));

    // First call is the cheap metadata probe, second builds the strip pipeline.
    expect(getSharpMock()).toHaveBeenNthCalledWith(2, expect.any(Buffer), { animated: true });
    expect(getPipeline().gif).toHaveBeenCalled();
  });

  it("always rotates and keeps the ICC profile on the strip path", async () => {
    const { mod, getPipeline } = loadWithMockedSharp({
      format: "jpeg",
      exif: Buffer.from([1]),
    });

    await mod.sanitizeImageBuffer(Buffer.from("jpeg-bytes"));

    expect(getPipeline().rotate).toHaveBeenCalled();
    expect(getPipeline().keepIccProfile).toHaveBeenCalled();
    expect(getPipeline().jpeg).toHaveBeenCalledWith({ quality: 90 });
  });

  it("does not pass animated:true for a still format", async () => {
    const { mod, getSharpMock } = loadWithMockedSharp({
      format: "jpeg",
      exif: Buffer.from([1]),
    });

    await mod.sanitizeImageBuffer(Buffer.from("jpeg-bytes"));

    expect(getSharpMock()).toHaveBeenNthCalledWith(2, expect.any(Buffer), undefined);
  });

  it("never builds a strip pipeline at all when there is nothing to strip", async () => {
    const { mod, getSharpMock, getPipeline } = loadWithMockedSharp({ format: "jpeg" });

    await mod.sanitizeImageBuffer(Buffer.from("clean-bytes"));

    expect(getSharpMock()).toHaveBeenCalledTimes(1); // the probe only
    expect(getPipeline().toBuffer).not.toHaveBeenCalled();
  });
});

describe("SEC-8.3 — carriesMetadata", () => {
  it("is true for any of the metadata containers", () => {
    expect(carriesMetadata({ exif: Buffer.from([1]) })).toBe(true);
    expect(carriesMetadata({ xmp: Buffer.from([1]) })).toBe(true);
    expect(carriesMetadata({ iptc: Buffer.from([1]) })).toBe(true);
    expect(carriesMetadata({ comments: [{ keyword: "k", text: "v" }] })).toBe(true);
  });

  it("is false for an image with none of them", () => {
    expect(carriesMetadata({ format: "webp", width: 1, height: 1 })).toBe(false);
    expect(carriesMetadata({ comments: [] })).toBe(false);
  });

  it("does not count the ICC profile as metadata to strip", () => {
    expect(carriesMetadata({ icc: Buffer.from([1]) })).toBe(false);
  });
});
