"use strict";

/**
 * autoTagService - classifies a style's tags automatically from its name,
 * prompt, and category, reusing the existing tag taxonomy whenever possible
 * (RecommendationService needs a closed, non-fragmenting vocabulary - see
 * migration_tags.sql/migration_seed_tags.sql). Used by both
 * styleController.createStyle/updateStyle (one style at a time) and
 * backfillTags.js (the whole catalog) - same pipeline, no separate heuristic.
 *
 * suggestTagsForStyle() NEVER throws for expected failure modes (Gemini
 * error, timeout, malformed output) - callers rely on this to never let a
 * classification failure block a style save. Real prompts are verbose,
 * multilingual natural language (Portuguese/Spanish/English observed in the
 * actual catalog), which is why this classifies by meaning via an LLM rather
 * than a hand-maintained keyword/synonym dictionary - that would need
 * per-language upkeep and become exactly the kind of manual busywork this
 * feature exists to eliminate.
 */

const { GoogleGenAI, Type } = require("@google/genai");
const tagModel = require("../models/tagModel");

// A separate, text-only model from GEMINI_MODEL (gemini-2.5-flash-image),
// which is an image-output model and the wrong tool for this.
const TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || "gemini-2.5-flash";

const MAX_TAGS = 6;
const CLASSIFY_TIMEOUT_MS = 10000;
const PROMPT_EXCERPT_LENGTH = 2000;

let aiClient = null;
function getClient() {
  if (!aiClient) {
    // Dedicated key for text classification - deliberately separate from
    // GEMINI_API_KEY (used by services/generation/geminiProvider.js, the
    // dormant image-generation provider; IMAGE_PROVIDER=fal is what's
    // actually active in production) so this feature's quota/billing never
    // gets entangled with that one.
    const apiKey = process.env.GEMINI_TAGGING_API_KEY;
    if (!apiKey) {
      throw new Error("[autoTagService] GEMINI_TAGGING_API_KEY is not defined in environment variables.");
    }
    aiClient = new GoogleGenAI({ apiKey });
  }
  return aiClient;
}

function buildClassificationPrompt({ name, prompt, categoryName, tagNames }) {
  const excerpt = prompt.slice(0, PROMPT_EXCERPT_LENGTH);
  return `You are tagging a photo-style preset for a recommendation engine that groups visually/thematically similar styles together.

Style name: ${name}
Category: ${categoryName}
Style prompt (may be written in any language - classify by meaning, not literal keyword matches): """${excerpt}"""

Existing tag vocabulary (choose ONLY from this exact list, by name, whenever any of them reasonably fit):
${tagNames.map((t) => `- ${t}`).join("\n")}

Pick the 2-5 tags from the list above that best describe this style's visual theme, genre, or mood. Only if truly NONE of the listed tags reasonably fit any aspect of this style, you may suggest one brand new tag name instead - keep it short (1-3 words), generic enough to apply to future styles too, and not overly specific to this one style.`;
}

function normalizeForFuzzyMatch(slug) {
  return slug.replace(/-/g, "");
}

/** Small Levenshtein distance - only ever run over a couple dozen short slugs. */
function levenshtein(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let i = 0; i < rows; i++) dp[i][0] = i;
  for (let j = 0; j < cols; j++) dp[0][j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

/**
 * Reuse-before-create safety net: a suggested new tag that's really just a
 * spacing/hyphenation variant or a near-typo of an existing one (e.g.
 * "Sci Fi" vs. existing "Sci-Fi") should reuse the existing tag rather than
 * fragment the taxonomy.
 */
function findFuzzyMatch(slug, existingTags) {
  const normalizedSlug = normalizeForFuzzyMatch(slug);
  for (const tag of existingTags) {
    const normalizedExisting = normalizeForFuzzyMatch(tag.slug);
    if (normalizedExisting === normalizedSlug) return tag;
    if (
      normalizedSlug.length >= 5 &&
      normalizedExisting.length >= 5 &&
      (normalizedExisting.includes(normalizedSlug) || normalizedSlug.includes(normalizedExisting))
    ) {
      return tag;
    }
    const shorter = Math.min(normalizedSlug.length, normalizedExisting.length);
    if (shorter <= 8 && levenshtein(normalizedSlug, normalizedExisting) <= 2) {
      return tag;
    }
  }
  return null;
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Gemini classification timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function classify({ name, prompt, categoryName, tagNames }) {
  const ai = getClient();

  const response = await ai.models.generateContent({
    model: TEXT_MODEL,
    contents: [
      {
        role: "user",
        parts: [{ text: buildClassificationPrompt({ name, prompt, categoryName, tagNames }) }],
      },
    ],
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          tagNames: { type: Type.ARRAY, items: { type: Type.STRING } },
          newTagSuggestion: { type: Type.STRING, nullable: true },
        },
        required: ["tagNames"],
      },
      temperature: 0,
    },
  });

  const text = response?.text;
  if (!text) {
    throw new Error("Gemini returned an empty response.");
  }

  return JSON.parse(text);
}

/**
 * @param {Object} params
 * @param {string} params.name
 * @param {string} params.prompt
 * @param {string} params.categoryName
 * @returns {Promise<{ tagIds: string[], status: 'ok'|'empty'|'error', errorMessage?: string }>}
 */
async function suggestTagsForStyle({ name, prompt, categoryName }) {
  try {
    const allTags = await tagModel.getAllTags();
    // A disabled/retired tag is excluded from both the prompt context and
    // from matching a returned name - it stays retired, never silently
    // resurrected by auto-tagging.
    const enabledTags = allTags.filter((t) => t.isEnabled);

    if (enabledTags.length === 0) {
      return { tagIds: [], status: "empty" };
    }

    const parsed = await withTimeout(
      classify({ name, prompt: prompt || "", categoryName, tagNames: enabledTags.map((t) => t.name) }),
      CLASSIFY_TIMEOUT_MS
    );

    const rawTagNames = Array.isArray(parsed?.tagNames) ? parsed.tagNames : [];
    const nameToTag = new Map(enabledTags.map((t) => [t.name.toLowerCase().trim(), t]));

    const matchedTags = [];
    const seenIds = new Set();
    for (const rawName of rawTagNames) {
      if (matchedTags.length >= MAX_TAGS) break;
      if (typeof rawName !== "string") continue;

      const tag = nameToTag.get(rawName.toLowerCase().trim());
      if (tag && !seenIds.has(tag.id)) {
        matchedTags.push(tag);
        seenIds.add(tag.id);
      }
      // Anything that doesn't match a real tag name is silently dropped -
      // never trust free-text output from the model as if it were a tag id.
    }

    if (matchedTags.length > 0) {
      return { tagIds: matchedTags.map((t) => t.id), status: "ok" };
    }

    // Nothing in the existing vocabulary matched - only now consider
    // creating a new tag, and only as a last resort.
    const suggestion = typeof parsed?.newTagSuggestion === "string" ? parsed.newTagSuggestion.trim() : "";
    if (!suggestion) {
      return { tagIds: [], status: "empty" };
    }

    const slug = tagModel.slugify(suggestion);
    if (!slug) {
      return { tagIds: [], status: "empty" };
    }

    const fuzzyMatch = findFuzzyMatch(slug, enabledTags);
    if (fuzzyMatch) {
      return { tagIds: [fuzzyMatch.id], status: "ok" };
    }

    try {
      const created = await tagModel.createTag({ name: suggestion, isEnabled: true });
      return { tagIds: [created.id], status: "ok" };
    } catch (err) {
      if (err.code === "23505") {
        // Race: a concurrent request/backfill worker created this exact
        // slug first - reuse it instead of failing.
        const existing = await tagModel.getTagBySlug(slug);
        if (existing) {
          return { tagIds: [existing.id], status: "ok" };
        }
      }
      throw err;
    }
  } catch (err) {
    console.error("[autoTagService] Classification failed:", err.message);
    return { tagIds: [], status: "error", errorMessage: err.message };
  }
}

module.exports = {
  suggestTagsForStyle,
};
