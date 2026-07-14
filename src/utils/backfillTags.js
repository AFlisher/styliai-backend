/**
 * One-off backfill: auto-tags every existing style that has no tags yet and
 * hasn't been manually curated, using the exact same autoTagService pipeline
 * styleController.createStyle/updateStyle use - not a separate heuristic.
 *
 * Safe to re-run and idempotent: a style that already has style_tags rows
 * drops out of the selection automatically, so killing this mid-run and
 * re-invoking later just resumes.
 *
 * status: 'ok' or 'empty' (Gemini genuinely classified it, even if to zero
 * tags) is a real result and gets written. status: 'error' - both the
 * primary and fallback model exhausted (quota/overload) or some other
 * classification failure - is left completely untouched: no write at all,
 * so the style has no style_tags rows and stays in the selection for the
 * next run instead of being permanently marked "done" with nothing to show
 * for it.
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
  let crashCount = 0;

  async function next() {
    while (index < items.length) {
      const current = items[index++];
      try {
        await worker(current);
      } catch (err) {
        crashCount++;
        console.error(`[backfillTags] Failed to process style ${current.id} (${current.name}):`, err.message);
      }
    }
  }

  const workerCount = Math.min(concurrency, items.length) || 0;
  await Promise.all(Array.from({ length: workerCount }, () => next()));
  return { crashCount };
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
  let taggedCount = 0;
  let emptyCount = 0;
  let pendingCount = 0;

  const { crashCount } = await runWithConcurrency(targets, CONCURRENCY, async (style) => {
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

    if (suggestion.status === "error") {
      // Both models exhausted (or some other classification failure) -
      // leave this style completely untouched rather than mark it "done"
      // with nothing to show for it. It has no style_tags rows, so it
      // stays in getStylesNeedingAutoTag()'s selection for the next run.
      pendingCount++;
      return;
    }

    if (suggestion.tagIds.length > 0) {
      taggedCount++;
    } else {
      emptyCount++;
    }

    if (!dryRun) {
      await styleModel.setStyleTagsAutoAssigned(style.id, suggestion.tagIds);
    }
  });

  console.log(
    `[backfillTags] Done. ${taggedCount} tagged, ${emptyCount} classified with no fitting tag, ${pendingCount} left pending (both models exhausted - will retry next run), ${crashCount} crashed.`
  );
  process.exitCode = crashCount > 0 ? 1 : 0;
}

main()
  .catch((err) => {
    console.error("[backfillTags] Fatal error:", err.message);
    process.exitCode = 1;
  })
  .finally(() => db.pool.end());
