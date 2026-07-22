const db = require("../config/db");

const STATS_RANGES = new Set(["today", "last7days", "last30days", "allTime"]);

// Mirrors the trailing-window convention already used by
// adminStatsController's countryDateFilterFor (CURRENT_DATE - N days =
// today + N preceding days). Kept local to this model rather than shared,
// since the column/alias it filters on differs per query below.
function dateFilterFor(range, column) {
  switch (range) {
    case "today":
      return `AND ${column} >= CURRENT_DATE`;
    case "last7days":
      return `AND ${column} >= CURRENT_DATE - INTERVAL '6 days'`;
    case "last30days":
      return `AND ${column} >= CURRENT_DATE - INTERVAL '29 days'`;
    case "allTime":
    default:
      return "";
  }
}

/**
 * Fixed-window counters for the dashboard's Overview cards. Intentionally
 * NOT range-filtered - each metric already names its own window (today /
 * this week / this month), unlike the rest of this model's queries which
 * are parameterized by the caller-selected range filter.
 */
async function getOverview() {
  const result = await db.query(`
    SELECT
      (SELECT COUNT(*)::int FROM generation_events WHERE success = true) AS "totalGenerations",
      (SELECT COUNT(*)::int FROM generation_events WHERE success = true AND created_at >= CURRENT_DATE) AS "todayGenerations",
      (SELECT COUNT(*)::int FROM generation_events WHERE success = true AND created_at >= date_trunc('week', CURRENT_DATE)) AS "thisWeekGenerations",
      (SELECT COUNT(*)::int FROM generation_events WHERE success = true AND created_at >= date_trunc('month', CURRENT_DATE)) AS "thisMonthGenerations",
      (SELECT COUNT(DISTINCT user_id)::int FROM generation_events WHERE success = true AND created_at >= CURRENT_DATE) AS "activeUsersToday",
      (SELECT COUNT(DISTINCT user_id)::int FROM generation_events WHERE success = true AND created_at >= date_trunc('month', CURRENT_DATE)) AS "activeUsersThisMonth"
  `);
  return result.rows[0];
}

async function getTopStyles(range, limit = 10) {
  const dateFilter = dateFilterFor(range, "ge.created_at");
  const result = await db.query(
    `
    SELECT
      s.id AS "styleId",
      COALESCE(s.name, 'Deleted style') AS "styleName",
      COUNT(*)::int AS count,
      ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 2)::float AS percentage
    FROM generation_events ge
    LEFT JOIN styles s ON s.id = ge.style_id
    WHERE ge.success = true ${dateFilter}
    GROUP BY s.id, s.name
    ORDER BY count DESC
    LIMIT $1
    `,
    [limit]
  );
  return result.rows;
}

async function getTopCategories(range, limit = 10) {
  const dateFilter = dateFilterFor(range, "ge.created_at");
  const result = await db.query(
    `
    SELECT
      c.id AS "categoryId",
      COALESCE(c.name, 'Deleted category') AS "categoryName",
      COUNT(*)::int AS count,
      ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 2)::float AS percentage
    FROM generation_events ge
    LEFT JOIN categories c ON c.id = ge.category_id
    WHERE ge.success = true ${dateFilter}
    GROUP BY c.id, c.name
    ORDER BY count DESC
    LIMIT $1
    `,
    [limit]
  );
  return result.rows;
}

async function getRatedStyles(range, minFeedbackCount, direction, limit = 10) {
  const dateFilter = dateFilterFor(range, "gf.created_at");
  const order = direction === "asc" ? "ASC" : "DESC";
  const result = await db.query(
    `
    SELECT
      s.id AS "styleId",
      COALESCE(s.name, 'Deleted style') AS "styleName",
      ROUND(AVG(gf.rating)::numeric, 2)::float AS "avgRating",
      COUNT(*)::int AS "feedbackCount"
    FROM generation_feedback gf
    LEFT JOIN styles s ON s.id = gf.style_id
    WHERE gf.style_id IS NOT NULL ${dateFilter}
    GROUP BY s.id, s.name
    HAVING COUNT(*) >= $1
    ORDER BY "avgRating" ${order}, "feedbackCount" DESC
    LIMIT $2
    `,
    [minFeedbackCount, limit]
  );
  return result.rows;
}

async function getGenerationTimeStats(range) {
  const dateFilter = dateFilterFor(range, "created_at");
  const overallResult = await db.query(`
    SELECT
      ROUND(AVG(generation_time_ms)::numeric, 0)::int AS "avgMs",
      COUNT(*)::int AS "sampleCount"
    FROM generation_events
    WHERE success = true AND generation_time_ms IS NOT NULL ${dateFilter}
  `);

  const perStyleDateFilter = dateFilterFor(range, "ge.created_at");
  const perStyleResult = await db.query(`
    SELECT
      s.id AS "styleId",
      COALESCE(s.name, 'Deleted style') AS "styleName",
      ROUND(AVG(ge.generation_time_ms)::numeric, 0)::int AS "avgMs"
    FROM generation_events ge
    LEFT JOIN styles s ON s.id = ge.style_id
    WHERE ge.success = true AND ge.generation_time_ms IS NOT NULL ${perStyleDateFilter}
    GROUP BY s.id, s.name
    ORDER BY "avgMs" ASC
  `);

  const perStyle = perStyleResult.rows;
  return {
    avgMs: overallResult.rows[0].avgMs,
    sampleCount: overallResult.rows[0].sampleCount,
    fastestStyle: perStyle.length > 0 ? perStyle[0] : null,
    slowestStyle: perStyle.length > 0 ? perStyle[perStyle.length - 1] : null,
  };
}

async function getFeedbackSummary(range) {
  const dateFilter = dateFilterFor(range, "created_at");
  const result = await db.query(`
    SELECT
      ROUND(AVG(rating)::numeric, 2)::float AS "avgRating",
      COUNT(*)::int AS "totalFeedback",
      COUNT(*) FILTER (WHERE rating = 5)::int AS "star5",
      COUNT(*) FILTER (WHERE rating = 4)::int AS "star4",
      COUNT(*) FILTER (WHERE rating = 3)::int AS "star3",
      COUNT(*) FILTER (WHERE rating = 2)::int AS "star2",
      COUNT(*) FILTER (WHERE rating = 1)::int AS "star1"
    FROM generation_feedback
    WHERE 1=1 ${dateFilter}
  `);
  const row = result.rows[0];
  return {
    avgRating: row.avgRating,
    totalFeedback: row.totalFeedback,
    distribution: {
      5: row.star5,
      4: row.star4,
      3: row.star3,
      2: row.star2,
      1: row.star1,
    },
  };
}

async function getRecentFeedback(range, limit = 20) {
  const dateFilter = dateFilterFor(range, "gf.created_at");
  const result = await db.query(
    `
    SELECT
      gf.id,
      u.email AS "userEmail",
      COALESCE(s.name, 'Deleted style') AS "styleName",
      gf.rating,
      gf.comment,
      gf.created_at AS "createdAt"
    FROM generation_feedback gf
    JOIN users u ON u.id = gf.user_id
    LEFT JOIN styles s ON s.id = gf.style_id
    WHERE 1=1 ${dateFilter}
    ORDER BY gf.created_at DESC
    LIMIT $1
    `,
    [limit]
  );
  return result.rows;
}

module.exports = {
  STATS_RANGES,
  getOverview,
  getTopStyles,
  getTopCategories,
  getRatedStyles,
  getGenerationTimeStats,
  getFeedbackSummary,
  getRecentFeedback,
};
