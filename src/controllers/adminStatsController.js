const db = require("../config/db");
const supabase = require("../config/supabase");

/**
 * Sums the size (bytes) of every object in the style-images bucket,
 * paginating past Supabase's default 100-item page size.
 */
async function getStorageUsedMB() {
  let totalBytes = 0;
  let offset = 0;
  const limit = 100;

  while (true) {
    const { data, error } = await supabase.storage
      .from("style-images")
      .list("", { limit, offset });

    if (error) throw error;
    if (!data || data.length === 0) break;

    for (const obj of data) {
      totalBytes += obj.metadata?.size || 0;
    }

    if (data.length < limit) break;
    offset += limit;
  }

  return totalBytes / (1024 * 1024);
}

async function getStats(req, res) {
  try {
    const totalUsersResult = await db.query(
      "SELECT COUNT(*)::int AS count FROM users"
    );

    // Approximation: counts users with any wallet activity today, not
    // literal login sessions (nothing tracks those - see
    // DASHBOARD_FUNCTIONAL_GAPS.md for why a true session metric isn't
    // possible without new auth instrumentation).
    const activeTodayResult = await db.query(
      "SELECT COUNT(DISTINCT user_id)::int AS count FROM wallet_transactions WHERE created_at >= CURRENT_DATE"
    );

    const imagesResult = await db.query(
      "SELECT COUNT(*)::int AS count FROM wallet_transactions WHERE type = 'generation'"
    );

    const creditsResult = await db.query(
      "SELECT COALESCE(SUM(ABS(amount)), 0)::int AS total FROM wallet_transactions WHERE type = 'generation'"
    );

    // Always 7 rows (today + preceding 6 days), zero-filled for days with
    // no generation activity, so the chart never has misleading gaps.
    const chartResult = await db.query(`
      SELECT
        to_char(d.day, 'Dy') AS label,
        COALESCE(COUNT(wt.id), 0)::int AS value
      FROM generate_series(CURRENT_DATE - INTERVAL '6 days', CURRENT_DATE, INTERVAL '1 day') AS d(day)
      LEFT JOIN wallet_transactions wt
        ON date_trunc('day', wt.created_at) = d.day AND wt.type = 'generation'
      GROUP BY d.day
      ORDER BY d.day
    `);

    const recentActivityResult = await db.query(`
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

    const storageUsedMB = await getStorageUsedMB();

    res.json({
      totalUsers: totalUsersResult.rows[0].count,
      activeToday: activeTodayResult.rows[0].count,
      imagesGenerated: imagesResult.rows[0].count,
      creditsUsed: creditsResult.rows[0].total,
      storageUsedMB: Math.round(storageUsedMB * 100) / 100,
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

module.exports = {
  getStats
};
