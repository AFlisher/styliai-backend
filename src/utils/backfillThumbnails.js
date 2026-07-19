/**
 * One-time backfill: generates and stores a browsing thumbnail for every
 * existing Style/Creation whose original image predates the thumbnail
 * system, so the mobile app's browsing screens (which load thumbnail_url
 * only) have something to show. Originals are never downloaded for
 * modification, never re-uploaded, and never deleted - this only creates a
 * new `${bucket}/thumbs/<name>.webp` object per row and fills in that row's
 * thumbnail column.
 *
 * Idempotent and safely re-runnable:
 *   - Each query only ever selects rows whose thumbnail column is still
 *     NULL, so a style/creation that already has a thumbnail is skipped
 *     entirely on the next run.
 *   - The thumbnail's storage filename is deterministically derived from the
 *     original's own filename (see baseNameFromUrl), and uploaded with
 *     upsert:true - so even a run that was killed after uploading the
 *     thumbnail but before writing the DB row just re-uploads the identical
 *     object in place on retry, instead of accumulating duplicates.
 *
 * Usage:
 *   node src/utils/backfillThumbnails.js [styles|creations|all] [--dry-run] [--limit=N] [--batch-size=N]
 *
 * Target defaults to "all" (styles, then creations). Batch size defaults to
 * 10 concurrent downloads/uploads at a time, to bound memory usage instead
 * of loading every original into memory at once.
 */

require("dotenv").config();

const db = require("../config/db");
const imageStorageService = require("../services/imageStorageService");

const DEFAULT_BATCH_SIZE = 10;
const STYLE_IMAGES_BUCKET = "style-images";
const CREATIONS_BUCKET = "creations";

function parseArgs(argv) {
  const target = argv.find((a) => !a.startsWith("--")) || "all";
  const dryRun = argv.includes("--dry-run");
  const limitArg = argv.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.split("=")[1]) : undefined;
  const batchArg = argv.find((a) => a.startsWith("--batch-size="));
  const batchSize = batchArg ? Number(batchArg.split("=")[1]) : DEFAULT_BATCH_SIZE;
  return { target, dryRun, limit, batchSize };
}

function chunk(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Derives a deterministic filename stem from an existing image URL, so
 * re-running the backfill regenerates the exact same thumbnail path every
 * time instead of piling up new objects on each run.
 */
function baseNameFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const last = pathname.split("/").filter(Boolean).pop() || "";
    const stem = last.replace(/\.[^/.]+$/, "");
    if (stem) return stem;
  } catch {
    // fall through to the hash-free slug below
  }
  return Buffer.from(url).toString("base64url").slice(0, 32);
}

async function fetchImageBuffer(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed (HTTP ${response.status})`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Generates + uploads (upsert) just the thumbnail for an already-stored
 * original. Unlike imageStorageService.uploadOriginalWithThumbnail, the
 * original here already exists in storage and is only ever downloaded, never
 * re-uploaded or modified.
 */
async function backfillOneThumbnail({ bucket, originalUrl, dryRun }) {
  const buffer = await fetchImageBuffer(originalUrl);
  const thumbnailBuffer = await imageStorageService.generateThumbnailBuffer(buffer);
  const baseName = baseNameFromUrl(originalUrl);

  // A dry run must have zero side effects: validate the image can be
  // downloaded and thumbnailed, but never touch storage.
  if (dryRun) return null;

  return imageStorageService.uploadObject({
    bucket,
    folder: "thumbs",
    buffer: thumbnailBuffer,
    contentType: "image/webp",
    filename: `${baseName}.webp`,
    upsert: true,
  });
}

/** Runs `worker` over `targets` in fixed-size batches, in parallel within
 * each batch, so memory stays bounded to one batch's worth of image buffers
 * at a time regardless of how many rows need backfilling. */
async function processInBatches(targets, batchSize, worker) {
  let doneCount = 0;
  let failedCount = 0;
  let processed = 0;

  for (const batch of chunk(targets, batchSize)) {
    await Promise.all(
      batch.map(async (item) => {
        processed++;
        try {
          await worker(item, processed);
          doneCount++;
        } catch (err) {
          failedCount++;
          console.error(`[backfillThumbnails] (${processed}/${targets.length}) ${item.label} -> FAILED: ${err.message}`);
        }
      })
    );
  }

  return { doneCount, failedCount };
}

async function backfillStyles({ dryRun, limit, batchSize }) {
  const { rows } = await db.query(`
    SELECT id, name, cover_image AS "coverImage"
    FROM styles
    WHERE cover_image_thumbnail IS NULL
      AND cover_image IS NOT NULL
      AND cover_image <> ''
    ORDER BY created_at ASC
  `);
  const targets = (limit ? rows.slice(0, limit) : rows).map((row) => ({ ...row, label: `style "${row.name}" (${row.id})` }));

  console.log(`[backfillThumbnails] styles: ${targets.length} need a thumbnail${dryRun ? " (dry run - no writes)" : ""}.`);

  const { doneCount, failedCount } = await processInBatches(targets, batchSize, async (style, i) => {
    const thumbnailUrl = await backfillOneThumbnail({ bucket: STYLE_IMAGES_BUCKET, originalUrl: style.coverImage, dryRun });
    if (!dryRun) {
      await db.query(`UPDATE styles SET cover_image_thumbnail = $1, updated_at = NOW() WHERE id = $2`, [thumbnailUrl, style.id]);
    }
    console.log(`[backfillThumbnails] (${i}/${targets.length}) ${style.label} -> ok`);
  });

  console.log(
    `[backfillThumbnails] styles done: ${doneCount} succeeded, ${failedCount} failed, ${targets.length - doneCount - failedCount} skipped mid-run.`
  );
  return { doneCount, failedCount };
}

async function backfillCreations({ dryRun, limit, batchSize }) {
  const { rows } = await db.query(`
    SELECT id, image_url AS "imageUrl"
    FROM creations
    WHERE thumbnail_url IS NULL
      AND image_url IS NOT NULL
      AND image_url <> ''
    ORDER BY created_at ASC
  `);
  const targets = (limit ? rows.slice(0, limit) : rows).map((row) => ({ ...row, label: `creation ${row.id}` }));

  console.log(`[backfillThumbnails] creations: ${targets.length} need a thumbnail${dryRun ? " (dry run - no writes)" : ""}.`);

  const { doneCount, failedCount } = await processInBatches(targets, batchSize, async (creation, i) => {
    const thumbnailUrl = await backfillOneThumbnail({ bucket: CREATIONS_BUCKET, originalUrl: creation.imageUrl, dryRun });
    if (!dryRun) {
      await db.query(`UPDATE creations SET thumbnail_url = $1 WHERE id = $2`, [thumbnailUrl, creation.id]);
    }
    console.log(`[backfillThumbnails] (${i}/${targets.length}) ${creation.label} -> ok`);
  });

  console.log(
    `[backfillThumbnails] creations done: ${doneCount} succeeded, ${failedCount} failed, ${targets.length - doneCount - failedCount} skipped mid-run.`
  );
  return { doneCount, failedCount };
}

async function main() {
  const { target, dryRun, limit, batchSize } = parseArgs(process.argv.slice(2));

  if (!["styles", "creations", "all"].includes(target)) {
    console.error(`[backfillThumbnails] Unknown target "${target}". Use "styles", "creations", or "all".`);
    process.exitCode = 1;
    return;
  }

  console.log(`[backfillThumbnails] Starting (target=${target}, batchSize=${batchSize}${dryRun ? ", DRY RUN" : ""})...`);

  let stylesResult = { doneCount: 0, failedCount: 0 };
  let creationsResult = { doneCount: 0, failedCount: 0 };

  if (target === "styles" || target === "all") {
    stylesResult = await backfillStyles({ dryRun, limit, batchSize });
  }
  if (target === "creations" || target === "all") {
    creationsResult = await backfillCreations({ dryRun, limit, batchSize });
  }

  const totalFailed = stylesResult.failedCount + creationsResult.failedCount;
  console.log("[backfillThumbnails] ==== Summary ====");
  console.log(`[backfillThumbnails] Styles:    ${stylesResult.doneCount} succeeded, ${stylesResult.failedCount} failed`);
  console.log(`[backfillThumbnails] Creations: ${creationsResult.doneCount} succeeded, ${creationsResult.failedCount} failed`);
  process.exitCode = totalFailed > 0 ? 1 : 0;
}

main()
  .catch((err) => {
    console.error("[backfillThumbnails] Fatal error:", err.message);
    process.exitCode = 1;
  })
  .finally(() => db.pool.end());

module.exports = {
  baseNameFromUrl,
};
