"use strict";

/**
 * R-2 (phase 1) — server-side avatar validation, sanitization and storage.
 *
 * Until now the backend was not on the avatar path at all. The app uploaded
 * straight to Supabase Storage, and the three things that looked like controls
 * each checked something other than the file:
 *
 *   - the bucket's `allowed_mime_types` checks the Content-Type the client
 *     itself sends. Measured: identical PNG bytes were ACCEPTED when labelled
 *     `image/jpeg` and REJECTED when labelled `image/png`. HTML, an SVG with a
 *     script, and a JPEG with an appended `<script>` were all accepted as
 *     `image/jpeg`.
 *   - the RLS policy checks the object NAME (`auth.uid() || '.jpg'`).
 *   - the Flutter re-encode runs on the uploader's own device.
 *
 * So the only thing standing between a picked file and a public object was
 * code the uploader controls. This module moves that decision server-side:
 * trust ends at the request boundary, and what reaches storage is a buffer
 * this process decoded and re-encoded itself.
 *
 * Phase 1 is additive. The bucket stays public, the direct-write RLS policies
 * stay in place, and the client is unchanged — so an old build keeps working
 * exactly as before. Making this endpoint mandatory means dropping those
 * policies, which is a later phase; until then this hardens the honest path
 * without breaking the installed base.
 */

const sharp = require("sharp");
const supabase = require("../config/supabase");
const db = require("../config/db");
const imageMetadataSanitizer = require("../utils/imageMetadataSanitizer");
const creationAssetCleanup = require("./creationAssetCleanup");
const { logger } = require("../utils/logger");

const AVATAR_BUCKET = "avatars";

/**
 * How long a redirect target stays valid, matching SEC-8.1B-2's creations
 * delivery. Short because nothing persists it: the client holds the stable
 * `/api/profile/avatar` address, and the signature exists only for the seconds
 * between the redirect and the fetch that follows it.
 */
const SIGNED_URL_TTL_SECONDS = 300;

/**
 * External hosts an avatar may legitimately point at.
 *
 * `profiles.avatar_url` holds a Google OAuth picture for most accounts, and
 * those are not ours to sign - the delivery endpoint has to hand the client the
 * original URL. That makes the endpoint a redirector, and the column is still
 * writable by the client through PostgREST, so the set of places it may send a
 * caller is an allow-list rather than "whatever the row says". Without it, a
 * user could point their own avatar at any URL and have our domain 302 to it.
 */
const ALLOWED_EXTERNAL_AVATAR_HOSTS = new Set([
  "lh3.googleusercontent.com",
  "lh4.googleusercontent.com",
  "lh5.googleusercontent.com",
  "lh6.googleusercontent.com",
]);

/**
 * Formats accepted for an avatar, decided from the decoded bytes.
 *
 * Narrower than the upload middleware's allow-list on purpose: GIF passes the
 * magic-byte check (it is a real image) but is refused here, because an avatar
 * has no use for animation and the frame handling is a complication with no
 * upside. The middleware answers "is this an image?"; this answers "is this an
 * avatar?".
 */
const ALLOWED_FORMATS = new Set(["jpeg", "png", "webp"]);

/**
 * Dimension ceilings, checked from the header before anything is decoded.
 *
 * Both are needed. A per-side limit alone lets 40000x100 through, and a total
 * pixel limit alone lets 100000x1 through; neither shape is a plausible avatar
 * and both are cheap to send. Measured motivation: a 10000x10000 JPEG is 572
 * KiB on the wire — comfortably inside the 10 MiB body limit — and ~286 MiB
 * decoded. The client caps its own uploads at 1024, so these are generous.
 */
const MAX_DIMENSION = 4096;
const MAX_PIXELS = 4096 * 4096;

/** Matches what the Flutter client already encodes at, and SEC-8.3's jpeg encoder. */
const AVATAR_JPEG_QUALITY = 90;

/**
 * A rejection the caller should report as a 400 with this message.
 *
 * Distinguished from an internal failure so the controller can answer "your
 * file is wrong" without turning a storage outage into the same response.
 * Messages are written to be shown to a user and say nothing about internals.
 */
class AvatarValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "AvatarValidationError";
    this.isAvatarValidation = true;
  }
}

/**
 * Decodes, validates and re-encodes arbitrary uploaded bytes into the exact
 * JPEG that will be stored.
 *
 * The order matters: every check that can be answered from the header runs
 * before any pixels are decoded, so a decompression bomb is refused on its
 * declared dimensions rather than by trying to decode it. `limitInputPixels`
 * is set as a second floor under that, for the decode that follows.
 *
 * The re-encode is UNCONDITIONAL, which is the one place this deliberately
 * differs from sanitizeImageBuffer's conditional pass-through. That
 * optimisation is right for provider output — re-encoding a generated image
 * to "sanitise" bytes we produced would degrade the product's main asset for
 * nothing. It is wrong here for two reasons:
 *
 *   - avatar bytes are attacker-controlled, and a JPEG with data appended
 *     after its end marker carries no metadata at all, so it would pass
 *     straight through byte-identical, appended payload intact. Re-encoding
 *     emits only what was decoded, so trailing bytes cannot survive.
 *   - the storage scheme is `<uid>.jpg` served as `image/jpeg`, so a PNG or
 *     WebP has to become a JPEG regardless.
 *
 * Stripping itself is NOT reimplemented here. sanitizeImageBuffer runs last
 * and remains the single owner of that logic (SEC-8.3); after the re-encode it
 * is a cheap header parse that finds nothing to do, and it is the assertion
 * that catches it if that ever stops being true.
 *
 * @param {Buffer} buffer - Raw uploaded bytes.
 * @returns {Promise<Buffer>} JPEG bytes, metadata-free.
 * @throws {AvatarValidationError} If the bytes are not an acceptable avatar.
 */
async function buildAvatarJpeg(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new AvatarValidationError("No image was received.");
  }

  let metadata;
  try {
    // No limitInputPixels here on purpose. metadata() parses the header and
    // decodes nothing, so the ceiling buys no safety at this point - and
    // setting it makes an oversized image throw here instead of reaching the
    // explicit check below, which would tell the user their photo was
    // unreadable when in fact it was simply too big.
    metadata = await sharp(buffer).metadata();
  } catch (err) {
    // Truncated, corrupt, or not an image at all. The magic-byte filter in the
    // upload middleware catches most of these; this catches a file whose
    // signature is right and whose contents are not.
    throw new AvatarValidationError("That image could not be read. Please choose a different photo.");
  }

  if (!ALLOWED_FORMATS.has(metadata.format)) {
    throw new AvatarValidationError("Avatars must be a JPEG, PNG or WebP image.");
  }

  // `pages` is how sharp reports animated WebP and multi-page containers. A
  // still image reports 1 (or leaves it undefined).
  if ((metadata.pages || 1) > 1) {
    throw new AvatarValidationError("Animated images cannot be used as an avatar.");
  }

  if (!metadata.width || !metadata.height) {
    throw new AvatarValidationError("That image could not be read. Please choose a different photo.");
  }

  if (
    metadata.width > MAX_DIMENSION ||
    metadata.height > MAX_DIMENSION ||
    metadata.width * metadata.height > MAX_PIXELS
  ) {
    throw new AvatarValidationError(
      `Image is too large. The maximum is ${MAX_DIMENSION}x${MAX_DIMENSION} pixels.`
    );
  }

  let normalized;
  try {
    normalized = await sharp(buffer, { limitInputPixels: MAX_PIXELS })
      // Bakes the EXIF orientation into the pixels. Without it, every portrait
      // phone photo is stored sideways once the tag is dropped - the same trap
      // documented in imageMetadataSanitizer and generateThumbnailBuffer.
      .rotate()
      // Colour profile survives; a plain re-encode visibly shifts wide-gamut
      // phone photos.
      .keepIccProfile()
      .jpeg({ quality: AVATAR_JPEG_QUALITY })
      .toBuffer();
  } catch (err) {
    throw new AvatarValidationError("That image could not be processed. Please choose a different photo.");
  }

  // SEC-8.3 owns metadata stripping. Nothing above re-implements it.
  const { buffer: sanitized } = await imageMetadataSanitizer.sanitizeImageBuffer(normalized);
  return sanitized;
}

/**
 * Validates, stores and records a new avatar for one user.
 *
 * The object name is unchanged from what the client has always written
 * (`<userId>.jpg`, upsert), so this endpoint and an old client build address
 * the same object and neither orphans the other's. Overwriting in place is
 * also why no deletion is needed here.
 *
 * The stored URL keeps its `?v=<epoch_ms>` cache-buster, again matching the
 * existing scheme - the object name never changes, so without it the CDN would
 * keep serving the previous avatar. SEC-8.4B is what makes that safe: the
 * referential guard now strips the query string before matching, so a
 * cache-busted URL is still recognised as a live reference.
 *
 * Only `profiles.avatar_url` is written, which is the column the app reads.
 * `users.avatar_url` is deliberately left alone: it holds the Google OAuth
 * picture for most accounts and reconciling the two is its own change.
 *
 * @returns {Promise<{avatarUrl: string}>}
 */
async function replaceAvatar({ userId, buffer }) {
  const jpeg = await buildAvatarJpeg(buffer);
  const path = `${userId}.jpg`;

  const { error } = await supabase.storage.from(AVATAR_BUCKET).upload(path, jpeg, {
    contentType: "image/jpeg",
    upsert: true,
  });

  if (error) {
    throw new Error(`[avatarService] Upload to ${AVATAR_BUCKET}/${path} failed: ${error.message}`);
  }

  const { data } = supabase.storage.from(AVATAR_BUCKET).getPublicUrl(path);
  const avatarUrl = `${data.publicUrl}?v=${Date.now()}`;

  await db.query("UPDATE public.profiles SET avatar_url = $1 WHERE id = $2", [avatarUrl, userId]);

  return { avatarUrl };
}

/**
 * Where to send a caller asking for their own avatar.
 *
 * R-2 phase 4. Returns one of:
 *   {kind:"signed",   url}  - our storage object, behind a short-lived signature
 *   {kind:"external", url}  - an allow-listed provider URL, passed through
 *   {kind:"none"}           - no avatar, or one pointing somewhere we refuse
 *
 * There is no user id parameter anywhere in this path, by construction: the
 * only avatar any caller can ask for is their own, so there is nothing to
 * enumerate. That is a stronger property than checking an id against the
 * session, because there is no id to get the check wrong about.
 */
async function resolveAvatarDelivery(userId) {
  const { rows } = await db.query(
    "SELECT avatar_url FROM public.profiles WHERE id = $1",
    [userId]
  );

  const stored = rows[0] && rows[0].avatar_url;
  if (!stored || typeof stored !== "string" || stored.trim() === "") {
    return { kind: "none" };
  }

  const parsed = creationAssetCleanup.parseStorageUrl(stored);

  if (!parsed || parsed.bucket !== AVATAR_BUCKET) {
    // Not one of our avatar objects. Either a provider picture we may forward,
    // or something we will not redirect to at all.
    let host;
    try {
      const asUrl = new URL(stored);
      host = asUrl.protocol === "https:" ? asUrl.hostname : null;
    } catch {
      host = null;
    }

    if (host && ALLOWED_EXTERNAL_AVATAR_HOSTS.has(host)) {
      return { kind: "external", url: stored };
    }
    return { kind: "none" };
  }

  const { data, error } = await supabase.storage
    .from(parsed.bucket)
    .createSignedUrl(parsed.path, SIGNED_URL_TTL_SECONDS);

  if (error || !data || !data.signedUrl) {
    throw new Error(
      `[avatarService] Signing ${parsed.bucket}/${parsed.path} failed: ${
        (error && error.message) || "no signed url returned"
      }`
    );
  }

  return { kind: "signed", url: data.signedUrl };
}

/**
 * Erases the caller's avatar object. Sprint 1 / B-1.
 *
 * This lives here rather than in creationAssetCleanup because `avatars` is
 * deliberately absent from that module's DELETABLE_BUCKETS allow-list, and that
 * absence is a safety property worth keeping: the generic eraser is driven by
 * URLs read out of content rows, and letting it reach avatars would put profile
 * pictures one bad URL away from deletion. Account deletion is the one caller
 * that legitimately needs the avatar gone, so it asks the service that owns the
 * bucket, by user id, for exactly one deterministic object.
 *
 * The path is reconstructed from the user id rather than parsed out of
 * `profiles.avatar_url` on purpose. replaceAvatar() writes `<userId>.jpg` with
 * `upsert: true`, so that is the only object this user can ever own here; the
 * stored URL additionally carries a `?v=` cache-buster and may point at an
 * external provider picture instead (Google's, for OAuth accounts), neither of
 * which addresses an object we can remove.
 *
 * NEVER THROWS, matching creationAssetCleanup's contract and for the same
 * reason: the account rows are already gone by the time this runs. A failure
 * here leaves one orphaned object, which is recoverable; propagating it would
 * turn a completed erasure into a 500 and invite the user to retry a deletion
 * that already succeeded.
 *
 * Removing a key that does not exist is not an error in the Storage API, so the
 * no-avatar case needs no special handling and a retry is safe.
 *
 * @returns {Promise<{deleted: number}>} 1 when the object was removed, 0 otherwise.
 */
async function deleteAvatar(userId) {
  const path = `${userId}.jpg`;

  try {
    const { error } = await supabase.storage.from(AVATAR_BUCKET).remove([path]);
    if (error) throw new Error(error.message);

    logger.info("avatar_erasure", { userId, bucket: AVATAR_BUCKET, outcome: "deleted" });
    return { deleted: 1 };
  } catch (err) {
    logger.error("avatar_erasure", {
      userId,
      bucket: AVATAR_BUCKET,
      outcome: "failed",
      // Message only - never the error object, per SEC-7.3.
      error: (err && err.message) || "unknown",
    });
    return { deleted: 0 };
  }
}

module.exports = {
  replaceAvatar,
  deleteAvatar,
  buildAvatarJpeg,
  resolveAvatarDelivery,
  AvatarValidationError,
  AVATAR_BUCKET,
  ALLOWED_FORMATS,
  ALLOWED_EXTERNAL_AVATAR_HOSTS,
  MAX_DIMENSION,
  MAX_PIXELS,
  SIGNED_URL_TTL_SECONDS,
};
