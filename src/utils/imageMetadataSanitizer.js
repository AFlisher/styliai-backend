"use strict";

/**
 * imageMetadataSanitizer — strips embedded metadata (EXIF, XMP, IPTC and
 * container comments) out of an image buffer, keeping the pixels and the
 * colour profile.
 *
 * SEC-8.3. Two call sites, for two different reasons:
 *
 *   - generationService, before the user's source photo is handed to a
 *     third-party provider. This is the leg that matters most: with
 *     IMAGE_PROVIDER=fal the source image is copied to fal's CDN under a
 *     public URL we neither control nor can delete, so anything left in the
 *     file leaves our infrastructure permanently. Real user photos reaching
 *     the backend today carry the capture timestamp, the UTC offset, a
 *     per-photo device ImageUniqueID and the handset's exact firmware build -
 *     and GPS whenever the photographer had location tagging on, because
 *     image_picker's ExifDataCopier deliberately copies all 32 GPS tags
 *     through the client's resize.
 *
 *   - imageStorageService, before an original is written to storage. The
 *     buckets are public with permanent unsigned URLs (SEC-8.1B), so stored
 *     metadata is readable by anyone holding the URL.
 *
 * Deliberately conditional: buffers with no embedded metadata are returned
 * byte-identical instead of being re-encoded. Provider output (Stability
 * WebP, Gemini/fal renders) carries no user metadata, and re-encoding it to
 * "sanitise" it would degrade the product's main asset for nothing - and
 * would throw away provider provenance markers if a provider ever starts
 * emitting them. The cheap header parse that decides this costs far less
 * than the encode it avoids.
 *
 * Scope limit worth stating: this targets the standard metadata containers
 * that sharp reports. A hand-crafted private APP segment or a custom chunk
 * would survive an image that is otherwise clean. That is an accepted gap -
 * the threat here is a photo leaking its owner's own location and device,
 * not an attacker smuggling bytes past us.
 *
 * GIF is a second, measured scope limit. libvips does not report a GIF's
 * comment or application extensions (verified: a GIF carrying a comment block
 * reports no metadata at all), so a GIF always takes the pass-through branch
 * and its extensions survive. Left that way on purpose: GIFs are not camera
 * originals, so none of the location/device tags this exists to remove can
 * reach us in one, while unconditionally re-encoding every GIF would put an
 * admin's animated cover through a frame re-encode for no privacy gain. The
 * `animated: true` guard below still matters, because it is what keeps that
 * decision from silently becoming "animations get flattened" if a future
 * libvips starts reporting GIF XMP.
 */

const sharp = require("sharp");

/**
 * Formats we can safely round-trip. Anything else fails closed rather than
 * being uploaded unsanitised: silently passing through the one file we
 * couldn't clean is exactly the outcome this module exists to prevent.
 *
 * The per-format encoder settings are the trade-off, made explicit:
 *   - jpeg  quality 90 matches what the Flutter client already encodes at,
 *           so the dominant path stacks no additional visible loss.
 *   - png   lossless; nothing to tune.
 *   - webp  quality 90, only ever reached by a user-supplied WebP.
 *   - gif   `animated: true` is set on the INPUT (see below), not here.
 */
const ENCODERS = {
  jpeg: (pipeline) => pipeline.jpeg({ quality: 90 }),
  png: (pipeline) => pipeline.png(),
  webp: (pipeline) => pipeline.webp({ quality: 90 }),
  gif: (pipeline) => pipeline.gif(),
};

/**
 * True when sharp can see any embedded metadata container in the image.
 * `exif` also covers a lone Orientation tag, which is why a rotated-only
 * photo still takes the re-encode path (and gets its orientation baked).
 */
function carriesMetadata(metadata) {
  return Boolean(
    metadata.exif ||
      metadata.xmp ||
      metadata.iptc ||
      (metadata.comments && metadata.comments.length > 0)
  );
}

/**
 * Removes embedded metadata from `buffer`, preserving its format.
 *
 * Returns the input buffer untouched when there is nothing to strip, so
 * callers can hand this every buffer without worrying about needless
 * re-encoding. `stripped` reports which happened.
 *
 * Three behaviours here are load-bearing and each one is a trap if omitted:
 *
 *   - `.rotate()` bakes the EXIF orientation into the pixels. sharp drops the
 *     Orientation tag along with the rest of the metadata, so stripping
 *     WITHOUT this turns every portrait phone photo sideways. This is the
 *     same reason generateThumbnailBuffer already calls it.
 *   - `{ animated: true }` on GIF input keeps every frame. Without it libvips
 *     reads page 1 only and a re-encoded animated GIF comes back as a still -
 *     measured, not assumed: a 3-frame GIF collapses to 1 page.
 *   - `.keepIccProfile()` retains the colour profile. A plain strip removes
 *     it too, which visibly shifts colours on wide-gamut phone photos.
 *
 * @param {Buffer} buffer - Image bytes.
 * @returns {Promise<{buffer: Buffer, format: string, stripped: boolean}>}
 * @throws If the bytes don't decode, or decode to a format we can't re-emit.
 */
async function sanitizeImageBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error("[imageMetadataSanitizer] A non-empty Buffer is required.");
  }

  let metadata;
  try {
    metadata = await sharp(buffer).metadata();
  } catch (err) {
    throw new Error(`[imageMetadataSanitizer] Unreadable image: ${err.message}`);
  }

  // The format comes from the bytes, never from a caller-supplied MIME type:
  // the upload filters verify that a file's magic bytes are *an* allowed image,
  // not that they match what the client declared.
  const format = metadata.format;
  const encode = ENCODERS[format];
  if (!encode) {
    throw new Error(`[imageMetadataSanitizer] Unsupported image format: ${format}`);
  }

  if (!carriesMetadata(metadata)) {
    return { buffer, format, stripped: false };
  }

  let sanitized;
  try {
    const pipeline = sharp(buffer, format === "gif" ? { animated: true } : undefined)
      .rotate()
      .keepIccProfile();
    sanitized = await encode(pipeline).toBuffer();
  } catch (err) {
    throw new Error(`[imageMetadataSanitizer] Failed to strip metadata: ${err.message}`);
  }

  return { buffer: sanitized, format, stripped: true };
}

module.exports = {
  sanitizeImageBuffer,
  // Exported for the avatar sweep and for tests, which both need to ask
  // "does this object still carry metadata?" without re-encoding it.
  carriesMetadata,
};
