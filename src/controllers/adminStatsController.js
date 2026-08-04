const db = require("../config/db");
const storageUsageService = require("../services/storageUsageService");

async function getStats(req, res) {
  try {
    const totalUsersResult = await db.analyticsQuery(
      "SELECT COUNT(*)::int AS count FROM users"
    );

    // Approximation: counts users with any wallet activity today, not
    // literal login sessions (nothing tracks those - see
    // DASHBOARD_FUNCTIONAL_GAPS.md for why a true session metric isn't
    // possible without new auth instrumentation).
    const activeTodayResult = await db.analyticsQuery(
      "SELECT COUNT(DISTINCT user_id)::int AS count FROM wallet_transactions WHERE created_at >= CURRENT_DATE"
    );

    const imagesResult = await db.analyticsQuery(
      "SELECT COUNT(*)::int AS count FROM wallet_transactions WHERE type = 'generation'"
    );

    const creditsResult = await db.analyticsQuery(
      "SELECT COALESCE(SUM(ABS(amount)), 0)::int AS total FROM wallet_transactions WHERE type = 'generation'"
    );

    // Always 7 rows (today + preceding 6 days), zero-filled for days with
    // no generation activity, so the chart never has misleading gaps.
    const chartResult = await db.analyticsQuery(`
      SELECT
        to_char(d.day, 'Dy') AS label,
        COALESCE(COUNT(wt.id), 0)::int AS value
      FROM generate_series(CURRENT_DATE - INTERVAL '6 days', CURRENT_DATE, INTERVAL '1 day') AS d(day)
      LEFT JOIN wallet_transactions wt
        ON date_trunc('day', wt.created_at) = d.day AND wt.type = 'generation'
      GROUP BY d.day
      ORDER BY d.day
    `);

    const recentActivityResult = await db.analyticsQuery(`
      SELECT
        wt.id,
        u.email AS "userEmail",
        wt.type,
        wt.amount,
        wt.created_at AS date
      FROM wallet_transactions wt
      JOIN users u ON u.id = wt.user_id
      ORDER BY wt.created_at DESC
      LIMIT 10
    `);

    // SEC-19.1: served from a TTL cache behind a single-flight latch, so a
    // dashboard refresh no longer starts a full bucket walk (and repeated
    // refreshes no longer start concurrent ones). Never throws - a storage
    // outage degrades this one card instead of failing the whole endpoint,
    // whose other six metrics come from Postgres and are unaffected.
    const storage = await storageUsageService.getStorageUsage();

    res.json({
      totalUsers: totalUsersResult.rows[0].count,
      activeToday: activeTodayResult.rows[0].count,
      imagesGenerated: imagesResult.rows[0].count,
      creditsUsed: creditsResult.rows[0].total,
      // Unchanged field name, unchanged units, unchanged rounding - existing
      // dashboard builds keep working. `null` is the new value only in the
      // case that previously produced a 500 for the entire response.
      storageUsedMB:
        storage.megabytes === null ? null : Math.round(storage.megabytes * 100) / 100,
      // Additive metadata. The audit asks for an "as of HH:MM" indicator so a
      // cached figure is not presented as a live one; `truncated` says the
      // walk hit its page cap and the number is a floor, not a total. Older
      // dashboard builds ignore all three.
      storageAsOf: storage.asOf ?? null,
      storageTruncated: Boolean(storage.truncated),
      storageObjectCount: storage.objectCount ?? null,
      chartData: chartResult.rows,
      recentActivity: recentActivityResult.rows,
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      message: "Failed to load analytics."
    });
  }
}

const COUNTRY_STATS_RANGES = new Set(["today", "last7days", "last30days", "allTime"]);

// Mirrors the trailing-window convention already used by getStats' 7-day
// chartData (CURRENT_DATE - 6 days = today + 6 preceding days).
function countryDateFilterFor(range) {
  switch (range) {
    case "today":
      return "AND created_at >= CURRENT_DATE";
    case "last7days":
      return "AND created_at >= CURRENT_DATE - INTERVAL '6 days'";
    case "last30days":
      return "AND created_at >= CURRENT_DATE - INTERVAL '29 days'";
    case "allTime":
    default:
      return "";
  }
}

async function getUsersByCountry(req, res) {
  const range = typeof req.query.range === "string" ? req.query.range : "allTime";
  if (!COUNTRY_STATS_RANGES.has(range)) {
    return res.status(400).json({
      message: "Invalid range. Must be one of: today, last7days, last30days, allTime."
    });
  }

  try {
    const dateFilter = countryDateFilterFor(range);
    const result = await db.analyticsQuery(`
      SELECT
        country_code AS "countryCode",
        country_name AS "countryName",
        COUNT(*)::int AS "userCount",
        ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 2)::float AS percentage
      FROM public.users
      WHERE country_code IS NOT NULL
        ${dateFilter}
      GROUP BY country_code, country_name
      ORDER BY "userCount" DESC
    `);

    res.json({ range, countries: result.rows });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      message: "Failed to load country analytics."
    });
  }
}

module.exports = {
  getStats,
  getUsersByCountry
};
