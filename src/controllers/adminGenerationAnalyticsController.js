const generationAnalyticsModel = require("../models/generationAnalyticsModel");

const DEFAULT_MIN_FEEDBACK_COUNT = 10;
const MAX_MIN_FEEDBACK_COUNT = 1000;

function parseRange(req) {
  return typeof req.query.range === "string" ? req.query.range : "allTime";
}

function parseMinFeedbackCount(req) {
  const raw = parseInt(req.query.minFeedbackCount, 10);
  if (!Number.isInteger(raw) || raw < 1) return DEFAULT_MIN_FEEDBACK_COUNT;
  return Math.min(raw, MAX_MIN_FEEDBACK_COUNT);
}

/**
 * Fixed-window overview cards (Total/Today/This Week/This Month generations,
 * Active Users Today/This Month) - not affected by the range filter, since
 * each metric already names its own window.
 */
async function getOverview(req, res) {
  try {
    const overview = await generationAnalyticsModel.getOverview();
    res.json(overview);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to load generation overview." });
  }
}

/**
 * Range-filtered generation analytics for the dashboard's Analytics page:
 * top styles/categories, highest/lowest rated styles, average generation
 * time, feedback summary, and recent feedback - all aggregated in SQL and
 * returned as one payload so the dashboard makes a single request per
 * filter change instead of aggregating raw rows in React.
 */
async function getSummary(req, res) {
  const range = parseRange(req);
  if (!generationAnalyticsModel.STATS_RANGES.has(range)) {
    return res.status(400).json({
      message: "Invalid range. Must be one of: today, last7days, last30days, allTime.",
    });
  }

  const minFeedbackCount = parseMinFeedbackCount(req);

  try {
    const [
      topStyles,
      topCategories,
      highestRatedStyles,
      lowestRatedStyles,
      generationTime,
      feedbackSummary,
      recentFeedback,
    ] = await Promise.all([
      generationAnalyticsModel.getTopStyles(range),
      generationAnalyticsModel.getTopCategories(range),
      generationAnalyticsModel.getRatedStyles(range, minFeedbackCount, "desc"),
      generationAnalyticsModel.getRatedStyles(range, minFeedbackCount, "asc"),
      generationAnalyticsModel.getGenerationTimeStats(range),
      generationAnalyticsModel.getFeedbackSummary(range),
      generationAnalyticsModel.getRecentFeedback(range),
    ]);

    res.json({
      range,
      minFeedbackCount,
      topStyles,
      topCategories,
      highestRatedStyles,
      lowestRatedStyles,
      generationTime,
      feedbackSummary,
      recentFeedback,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to load generation analytics." });
  }
}

module.exports = {
  getOverview,
  getSummary,
};
