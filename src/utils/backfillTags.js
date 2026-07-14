/**
 * One-off backfill: auto-tags every existing style that has no tags yet and
 * hasn't been manually curated, using the exact same autoTagService pipeline
 * styleController.createStyle/updateStyle use - not a separate heuristic.
 *
 * Safe to re-run: a style that already has style_tags rows drops out of the
 * selection automatically, so killing this mid-run and re-invoking later
 * just resumes. A style that legitimately got zero tags (Gemini found no
 * fit, or a transient classification error) naturally stays eligible and
 * gets retried on the next run too.
 *
 * Usage:
 *   node src/utils/backfillTags.js [--dry-run] [--limit=N]
 */

require("dotenv").config();

const db = require("../config/db");
const styleModel = require("../models/styleModel");
const categoryModel = require("../models/categoryModel");
const autoTagService = require("../services/autoTagService");

const CONCURRENCY = Number(process.env.AUTOTAG_BACKFILL_CONCURRENCY) || 3;

function parseArgs(argv) {
  const dryRun = argv.includes("--dry-run");
  const limitArg = argv.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.split("=")[1]) : undefined;
  return { dryRun, limit };
}

/** Bounded-concurrency worker pool - no new dependency for a one-off script. */
async function runWithConcurrency(items, concurrency, worker) {
  let index = 0;
  let errorCount = 0;

  async function next() {
    while (index < items.length) {
      const current = items[index++];
      try {
        await worker(current);
      } catch (err) {
        errorCount++;
        console.error(`[backfillTags] Failed to process style ${current.id} (${current.name}):`, err.message);
      }
    }
  }

  const workerCount = Math.min(concurrency, items.length) || 0;
  await Promise.all(Array.from({ length: workerCount }, () => next()));
  return { errorCount };
}

async function main() {
  const { dryRun, limit } = parseArgs(process.argv.slice(2));

  const categories = await categoryModel.getAllCategories();
  const categoryNameById = new Map(categories.map((c) => [c.id, c.name]));

  let targets = await styleModel.getStylesNeedingAutoTag();
  if (limit) {
    targets = targets.slice(0, limit);
  }

  console.log(`[backfillTags] ${targets.length} style(s) need tagging${dryRun ? " (dry run - no writes)" : ""}.`);

  let processed = 0;
  const { errorCount } = await runWithConcurrency(targets, CONCURRENCY, async (style) => {
    const suggestion = await autoTagService.suggestTagsForStyle({
      name: style.name,
      prompt: style.prompt,
      categoryName: categoryNameById.get(style.categoryId) ?? "",
    });

    processed++;
    const modelNote = suggestion.modelUsed ? ` via "${suggestion.modelUsed}"` : "";
    console.log(
      `[backfillTags] (${processed}/${targets.length}) "${style.name}" -> ${suggestion.status} [${suggestion.tagIds.length} tag(s)]${modelNote}`
    );

    if (!dryRun) {
      await styleModel.setStyleTagsAutoAssigned(style.id, suggestion.tagIds);
    }
  });

  console.log(`[backfillTags] Done. ${targets.length - errorCount} processed, ${errorCount} failed.`);
  process.exitCode = errorCount > 0 ? 1 : 0;
}

main()
  .catch((err) => {
    console.error("[backfillTags] Fatal error:", err.message);
    process.exitCode = 1;
  })
  .finally(() => db.pool.end());
