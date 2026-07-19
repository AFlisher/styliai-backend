"use strict";

/**
 * imageStorageService — the single place that turns an image buffer into
 * stored Supabase Storage objects, original + browsing thumbnail together.
 *
 * Every upload path in the app (admin style-image uploads, style-transfer
 * generation, Stability text-to-image, and the one-off backfill script)
 * goes through this instead of hand-rolling its own
 * `supabase.storage.upload()` + resize logic. Buckets keep their existing
 * names ("style-images", "creations"); the original/thumbnail split lives
 * in path prefixes within each bucket ("original/", "thumbs/") rather than
 * provisioning new buckets.
 */

const sharp = require("sharp");
const { v4: uuid } = require("uuid");
const supabase = require("../config/supabase");

const THUMBNAIL_WIDTH = 320;
const THUMBNAIL_HEIGHT = 400;
const THUMBNAIL_QUALITY = 80;

const MIME_TO_EXTENSION = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

function extensionFromMime(mimeType) {
  return MIME_TO_EXTENSION[mimeType] || "jpg";
}

/**
 * Generates a ~320x400 (4:5) WebP thumbnail from an arbitrary source image
 * buffer. `fit: "cover"` + `position: sharp.strategy.attention` crops toward
 * the most visually interesting region (faces, edges, high-frequency detail)
 * instead of a plain center-crop, so off-center subjects and portraits still
 * frame sensibly at the fixed thumbnail aspect ratio.
 */
async function generateThumbnailBuffer(sourceBuffer) {
  return sharp(sourceBuffer)
    .rotate() // normalize EXIF orientation before cropping
    .resize(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT, {
      fit: "cover",
      position: sharp.strategy.attention,
    })
    .webp({ quality: THUMBNAIL_QUALITY })
    .toBuffer();
}

/**
 * Uploads a buffer to `${bucket}/${folder}/${filename}` and returns its
 * public URL. `upsert` defaults to false (every hot-path caller uses a fresh
 * uuid filename, so a collision would mean something's wrong) - the backfill
 * script is the one caller that deliberately passes `upsert: true`, since it
 * re-derives the same deterministic filename from the original on every run
 * and must overwrite in place instead of erroring on re-run.
 */
async function uploadObject({ bucket, folder, buffer, contentType, filename, upsert = false }) {
  const path = `${folder}/${filename}`;
  const { error } = await supabase.storage.from(bucket).upload(path, buffer, {
    contentType,
    upsert,
  });

  if (error) {
    throw new Error(`[imageStorageService] Upload to ${bucket}/${path} failed: ${error.message}`);
  }

  const { data } = supabase.storage.from(bucket).getPublicUrl(path);
  return data.publicUrl;
}

/**
 * Stores both the full-resolution original and a generated browsing
 * thumbnail for one source image, under the same filename stem so the two
 * are trivially correlated in the bucket listing (`original/<name>.<ext>`,
 * `thumbs/<name>.webp`).
 *
 * Thumbnail generation/upload is best-effort: a failure there (corrupt
 * source bytes, a transient storage hiccup, ...) must never block saving the
 * original, since the original is the asset of record. On failure,
 * `thumbnailUrl` comes back `null` and the row stays eligible for the
 * backfill script to retry later.
 *
 * @param {Object} params
 * @param {Buffer} params.buffer - Original image bytes, full quality/resolution.
 * @param {string} params.mimeType - Original's MIME type (drives its extension).
 * @param {string} params.bucket - Supabase Storage bucket, e.g. "style-images" or "creations".
 * @param {string} [params.baseName] - Filename stem (defaults to a fresh uuid).
 * @returns {Promise<{url: string, thumbnailUrl: string|null}>}
 */
async function uploadOriginalWithThumbnail({ buffer, mimeType, bucket, baseName }) {
  const name = baseName || uuid();
  const extension = extensionFromMime(mimeType);

  const url = await uploadObject({
    bucket,
    folder: "original",
    buffer,
    contentType: mimeType,
    filename: `${name}.${extension}`,
  });

  let thumbnailUrl = null;
  try {
    const thumbnailBuffer = await generateThumbnailBuffer(buffer);
    thumbnailUrl = await uploadObject({
      bucket,
      folder: "thumbs",
      buffer: thumbnailBuffer,
      contentType: "image/webp",
      filename: `${name}.webp`,
    });
  } catch (err) {
    console.error(
      `[imageStorageService] Thumbnail generation/upload failed for ${bucket}/original/${name}.${extension}:`,
      err.message
    );
  }

  return { url, thumbnailUrl };
}

/**
 * Extracts the storage object path (relative to `bucket`) from one of
 * Supabase's public URLs, e.g.
 * ".../storage/v1/object/public/style-images/original/abc.jpg" ->
 * "original/abc.jpg". Returns null if `url` doesn't belong to `bucket`.
 */
function objectPathFromPublicUrl(bucket, url) {
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }

  const marker = `/${bucket}/`;
  const idx = pathname.indexOf(marker);
  if (idx === -1) return null;

  const objectPath = decodeURIComponent(pathname.slice(idx + marker.length));
  return objectPath || null;
}

/**
 * Deletes an original image and its companion thumbnail (if the URL follows
 * the "original/<name>.<ext>" layout) from `bucket`. Legacy flat-file URLs
 * (pre-thumbnail-system uploads, stored directly at the bucket root) have no
 * companion thumbnail and are just deleted as-is.
 */
async function deleteOriginalAndThumbnail({ bucket, url }) {
  const objectPath = objectPathFromPublicUrl(bucket, url);
  if (!objectPath) {
    throw new Error("INVALID_IMAGE_URL");
  }

  const paths = [objectPath];
  if (objectPath.startsWith("original/")) {
    const base = objectPath.slice("original/".length).replace(/\.[^/.]+$/, "");
    paths.push(`thumbs/${base}.webp`);
  }

  const { error } = await supabase.storage.from(bucket).remove(paths);
  if (error) {
    throw new Error(`[imageStorageService] Delete from ${bucket} failed: ${error.message}`);
  }
}

module.exports = {
  THUMBNAIL_WIDTH,
  THUMBNAIL_HEIGHT,
  extensionFromMime,
  generateThumbnailBuffer,
  uploadObject,
  uploadOriginalWithThumbnail,
  objectPathFromPublicUrl,
  deleteOriginalAndThumbnail,
};
