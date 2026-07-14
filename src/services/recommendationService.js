/**
 * RecommendationService - the single place ranking logic for "similar
 * styles" and "recommended for you" lives. Flutter never scores anything;
 * it only renders whatever this service (via styleController /
 * recommendationController) returns.
 *
 * Deterministic, rule-based weighted scoring - no ML/embeddings. The
 * catalog is small enough that a tag-overlap scorer is both sufficient and
 * far cheaper to reason about/tune than introducing model infra that
 * doesn't exist anywhere else in this backend.
 */

const db = require("../config/db");
const styleModel = require("../models/styleModel");
const favoritesModel = require("../models/favoritesModel");
const creationsModel = require("../models/creationsModel");

// Tuning knobs - deliberately a single flat object so weights are a one-line
// change without touching the scoring logic itself.
const WEIGHTS = {
  tagOverlap: 10,             // per shared tag between candidate and anchor style
  sameCategory: 4,            // candidate shares a category with the anchor/preferred category
  favoritedStyleTagBonus: 6,  // per shared tag with a style the user favorited
  creationStyleTagBonus: 4,   // per shared tag with a style the user generated (implicit, weaker than a favorite)
  trendingBoost: 3,
  recencyBonus: 2,            // small tie-breaker favoring newer styles
};

// The "all enabled styles + their tags" candidate fetch is shared by every
// recommendation request. There's no Redis/cache layer anywhere in this
// backend and introducing one for this alone would be disproportionate, so
// this is a bare in-process memo, not a generic cache abstraction.
const CANDIDATE_CACHE_TTL_MS = 60 * 1000;
let candidateCache = null;

async function getCandidates() {
  if (candidateCache && candidateCache.expiresAt > Date.now()) {
    return candidateCache.data;
  }

  const data = await styleModel.getEnabledStylesWithTags();
  candidateCache = { data, expiresAt: Date.now() + CANDIDATE_CACHE_TTL_MS };
  return data;
}

/**
 * Called by the Admin Dashboard write paths (style/tag create/update/delete)
 * so a curation change is reflected well before the 60s TTL would expire on
 * its own.
 */
function invalidateCandidateCache() {
  candidateCache = null;
}

function buildRecencyContext(candidates) {
  if (candidates.length === 0) {
    return { oldestMs: 0, rangeMs: 0 };
  }

  const timestamps = candidates.map((c) => new Date(c.createdAt).getTime());
  const oldestMs = Math.min(...timestamps);
  const newestMs = Math.max(...timestamps);
  return { oldestMs, rangeMs: newestMs - oldestMs };
}

function computeRecencyBonus(createdAt, { oldestMs, rangeMs }) {
  if (rangeMs <= 0) {
    return 0;
  }

  const ageFraction = (new Date(createdAt).getTime() - oldestMs) / rangeMs;
  return ageFraction * WEIGHTS.recencyBonus;
}

function countTagOverlap(candidateTagIds, tagIdSet) {
  let count = 0;
  for (const tagId of candidateTagIds) {
    if (tagIdSet.has(tagId)) {
      count += 1;
    }
  }
  return count;
}

async function hydrateInScoreOrder(scored) {
  const ids = scored.map((s) => s.id);
  const styles = await styleModel.getPublicStylesByIds(ids);
  const orderIndex = new Map(ids.map((id, i) => [id, i]));
  styles.sort((a, b) => orderIndex.get(a.id) - orderIndex.get(b.id));
  return styles;
}

/**
 * Style Details "You may also like" - anchor is the style being viewed, no
 * user signal at all, so this works identically (and is never gated) for
 * anonymous and logged-in callers alike.
 */
async function getSimilarStyles({ styleId, limit = 10 }) {
  const anchor = await styleModel.getStyleById(styleId);
  if (!anchor || !anchor.isEnabled) {
    return null;
  }

  const candidates = await getCandidates();
  const anchorTagSet = new Set(anchor.tagIds);
  const recency = buildRecencyContext(candidates);

  const scored = candidates
    .filter((c) => c.id !== styleId)
    .map((c) => {
      let score = countTagOverlap(c.tagIds, anchorTagSet) * WEIGHTS.tagOverlap;
      if (c.categoryId === anchor.categoryId) score += WEIGHTS.sameCategory;
      if (c.isTrending) score += WEIGHTS.trendingBoost;
      score += computeRecencyBonus(c.createdAt, recency);
      return { id: c.id, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return hydrateInScoreOrder(scored);
}

/**
 * Home "Recommended For You". Per product decision: a user with zero
 * favorites and zero creations gets an empty list, not a Trending
 * substitute - the section simply doesn't render rather than feel like a
 * duplicate of Trending. The personalization-toggle gate itself lives one
 * layer up in styleController, which must not even call this function when
 * the toggle is off or the caller is anonymous.
 */
async function getPersonalizedRecommendations({ userId, limit = 10 }) {
  const [favoriteIds, creations] = await Promise.all([
    favoritesModel.getFavoriteStyleIds(userId),
    creationsModel.getCreationsByUser(userId),
  ]);

  const creationStyleIds = [...new Set(creations.map((c) => c.styleId).filter(Boolean))];

  if (favoriteIds.length === 0 && creationStyleIds.length === 0) {
    return [];
  }

  const candidates = await getCandidates();
  const candidatesById = new Map(candidates.map((c) => [c.id, c]));

  const tagWeights = new Map();
  const categoryCounts = new Map();

  const accumulate = (styleIds, tagBonus) => {
    for (const styleId of styleIds) {
      const style = candidatesById.get(styleId);
      if (!style) continue;

      for (const tagId of style.tagIds) {
        tagWeights.set(tagId, (tagWeights.get(tagId) || 0) + tagBonus);
      }
      categoryCounts.set(style.categoryId, (categoryCounts.get(style.categoryId) || 0) + 1);
    }
  };

  accumulate(favoriteIds, WEIGHTS.favoritedStyleTagBonus);
  accumulate(creationStyleIds, WEIGHTS.creationStyleTagBonus);

  let preferredCategoryId = null;
  let maxCategoryCount = 0;
  for (const [categoryId, count] of categoryCounts) {
    if (count > maxCategoryCount) {
      maxCategoryCount = count;
      preferredCategoryId = categoryId;
    }
  }

  const excludeIds = new Set(favoriteIds);
  const recency = buildRecencyContext(candidates);

  const scored = candidates
    .filter((c) => !excludeIds.has(c.id))
    .map((c) => {
      let score = 0;
      for (const tagId of c.tagIds) {
        score += tagWeights.get(tagId) || 0;
      }
      if (preferredCategoryId && c.categoryId === preferredCategoryId) score += WEIGHTS.sameCategory;
      if (c.isTrending) score += WEIGHTS.trendingBoost;
      // Relevance is judged before recency is added in - recency is only a
      // tie-breaker among already-relevant candidates. Letting a brand-new,
      // completely unrelated style in purely because it's recent is exactly
      // the "feels like a Trending duplicate" outcome this feature must avoid.
      const relevance = score;
      score += computeRecencyBonus(c.createdAt, recency);
      return { id: c.id, relevance, score };
    })
    .filter((s) => s.relevance > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return hydrateInScoreOrder(scored);
}

async function isPersonalizationEnabled(userId) {
  const result = await db.query(
    `SELECT personalization_enabled AS "personalizationEnabled" FROM profiles WHERE id = $1`,
    [userId]
  );

  return result.rows[0]?.personalizationEnabled ?? true;
}

module.exports = {
  WEIGHTS,
  getPersonalizedRecommendations,
  getSimilarStyles,
  isPersonalizationEnabled,
  invalidateCandidateCache,
};
