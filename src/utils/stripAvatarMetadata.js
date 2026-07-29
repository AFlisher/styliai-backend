/**
 * SEC-8.3 (leg C) — one-time sweep of avatars that were stored before the app
 * started stripping metadata.
 *
 * Avatars are the one image the backend never sees on the way in: the Flutter
 * client uploads them straight to Supabase Storage (profile_service.dart), so
 * there is no server-side choke point to sanitise them at, and the client fix
 * only helps uploads made from a build that has it. Everything already in the
 * bucket stays exactly as it was uploaded until something rewrites it. That is
 * what this does.
 *
 * At the time this was written all 4 live avatars carried an EXIF block naming
 * the handset's exact firmware build, the capture timestamp, the user's UTC
 * offset and a per-photo device ImageUniqueID — publicly readable, at a URL
 * derived from the owner's user id.
 *
 * Usage:
 *   node src/utils/stripAvatarMetadata.js [--apply] [--limit=N]
 *
 * ─── Safety properties ────────────────────────────────────────────────────
 *
 * DRY RUN IS THE DEFAULT, matching reconcileOrphanedCreations.js. Writing
 * requires `--apply`, spelled out.
 *
 * This tool REPLACES objects in place and the original bytes are not kept
 * anywhere. It is not as destructive as a delete — the picture itself survives,
 * re-encoded — but it is not reversible either: the stripped metadata is gone,
 * which is the entire point, and the re-encode is lossy for JPEG.
 *
 * Only ever touches the `avatars` bucket, and within it only objects that
 * actually carry metadata. A clean avatar is left byte-identical rather than
 * being re-encoded for nothing.
 *
 * ─── What this does NOT do ────────────────────────────────────────────────
 *
 * It does not touch the database. `profiles.avatar_url` stores a URL with a
 * `?v=<timestamp>` cache-buster minted by the client at upload time, so
 * rewriting the object does not change the URL anyone is already holding, and
 * Supabase's CDN may keep serving the old (metadata-bearing) bytes until its
 * TTL expires. Whether to also re-mint that timestamp is a separate decision
 * with a separate blast radius (it writes to every affected user's row), and is
 * deliberately not bundled in here.
 */

require("dotenv").config();

const db = require("../config/db");
const supabase = require("../config/supabase");
const sharp = require("sharp");
const {
  sanitizeImageBuffer,
  carriesMetadata,
} = require("./imageMetadataSanitizer");

/**
 * Locked to one bucket by construction rather than by an argument. `avatars`
 * is the only bucket whose contents the backend never got to sanitise on the
 * way in; the other two are covered at the upload choke point, and pointing a
 * bulk in-place rewriter at the product catalog has no upside.
 */
const BUCKET = "avatars";
const PAGE_SIZE = 1000;

function parseArgs(argv) {
  const limitArg = argv.find((a) => a.startsWith("--limit="));

  return {
    // Dry run unless --apply is spelled out.
    dryRun: !argv.includes("--apply"),
    limit: limitArg ? Number(limitArg.split("=")[1]) : undefined,
  };
}

/** Avatars are flat (`<userId>.jpg`), but paginate anyway rather than truncate. */
async function listAvatars() {
  const objects = [];
  let offset = 0;

  for (;;) {
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .list("", { limit: PAGE_SIZE, offset, sortBy: { column: "name", order: "asc" } });

    if (error) throw new Error(`list ${BUCKET} failed: ${error.message}`);
    if (!data || data.length === 0) break;

    for (const entry of data) {
      // Supabase reports a synthetic folder row with a null id.
      if (entry.id === null || entry.id === undefined) continue;
      objects.push({ path: entry.name, contentType: entry.metadata?.mimetype || "image/jpeg" });
    }

    if (data.length < PAGE_SIZE) break;
    offset += data.length;
  }

  return objects;
}

async function main() {
  const { dryRun, limit } = parseArgs(process.argv.slice(2));

  console.log(
    `[strip-avatars] bucket=${BUCKET} ${dryRun ? "DRY RUN (no writes)" : "*** REWRITING OBJECTS ***"}`
  );

  const objects = await listAvatars();
  console.log(`[strip-avatars] ${objects.length} objects in ${BUCKET}.`);

  let clean = 0;
  let rewritten = 0;
  let failed = 0;
  const candidates = [];

  for (const object of objects) {
    // eslint-disable-next-line no-await-in-loop
    const { data, error } = await supabase.storage.from(BUCKET).download(object.path);
    if (error) {
      console.error(`[strip-avatars] download ${object.path} failed: ${error.message}`);
      failed++;
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    const buffer = Buffer.from(await data.arrayBuffer());

    let metadata;
    try {
      // eslint-disable-next-line no-await-in-loop
      metadata = await sharp(buffer).metadata();
    } catch (err) {
      console.error(`[strip-avatars] unreadable ${object.path}: ${err.message}`);
      failed++;
      continue;
    }

    if (!carriesMetadata(metadata)) {
      clean++;
      continue;
    }

    candidates.push({ ...object, buffer });
    if (limit && candidates.length >= limit) break;
  }

  console.log(`[strip-avatars] already clean: ${clean}`);
  console.log(`[strip-avatars] carrying metadata: ${candidates.length}`);
  candidates.forEach((c) =>
    console.log(`[strip-avatars]   ${dryRun ? "would rewrite" : "rewriting"}: ${BUCKET}/${c.path}`)
  );

  if (candidates.length === 0 || dryRun) {
    if (dryRun && candidates.length > 0) {
      console.log(
        "[strip-avatars] Dry run only. Re-run with --apply to rewrite the objects listed above."
      );
      console.log(
        "[strip-avatars] NOTE: the public URL does not change, so the CDN may serve the old " +
          "bytes until its TTL expires. See the header of this file."
      );
    }
    if (failed > 0) process.exitCode = 1;
    return;
  }

  for (const candidate of candidates) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const { buffer: sanitized } = await sanitizeImageBuffer(candidate.buffer);

      // eslint-disable-next-line no-await-in-loop
      const { error } = await supabase.storage
        .from(BUCKET)
        .upload(candidate.path, sanitized, { contentType: candidate.contentType, upsert: true });
      if (error) throw new Error(error.message);

      // Read back and confirm, rather than trusting the write. This sweep is
      // the only evidence the objects were ever cleaned, so an unverified
      // "done" would be worth nothing.
      // eslint-disable-next-line no-await-in-loop
      const { data: check, error: checkErr } = await supabase.storage
        .from(BUCKET)
        .download(candidate.path);
      if (checkErr) throw new Error(`verification download failed: ${checkErr.message}`);

      // eslint-disable-next-line no-await-in-loop
      const checkMeta = await sharp(Buffer.from(await check.arrayBuffer())).metadata();
      if (carriesMetadata(checkMeta)) {
        throw new Error("object still carries metadata after rewrite");
      }

      rewritten++;
      console.log(`[strip-avatars]   ok: ${BUCKET}/${candidate.path}`);
    } catch (err) {
      failed++;
      console.error(`[strip-avatars]   FAILED ${BUCKET}/${candidate.path}: ${err.message}`);
    }
  }

  console.log(
    `[strip-avatars] ==== rewrote ${rewritten}/${candidates.length} avatars; ${failed} failure(s). ====`
  );
  console.log(
    "[strip-avatars] NOTE: public URLs are unchanged, so the CDN may serve the old bytes " +
      "until its TTL expires."
  );
  if (failed > 0) process.exitCode = 1;
}

// Only when run as a script — importing this module must not start rewriting
// production objects. Same reasoning as reconcileOrphanedCreations.js.
if (require.main === module) {
  main()
    .catch((err) => {
      console.error("[strip-avatars] Fatal error:", err.message);
      process.exitCode = 1;
    })
    .finally(() => db.pool.end());
}

module.exports = { __testing: { parseArgs, listAvatars, BUCKET } };
