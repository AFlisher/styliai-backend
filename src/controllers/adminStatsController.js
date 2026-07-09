const db = require("../config/db");

async function getStats(req, res) {
  try {
    const totalUsersResult = await db.query(
      "SELECT COUNT(*)::int AS count FROM users"
    );

    const imagesResult = await db.query(
      "SELECT COUNT(*)::int AS count FROM generated_images"
    );

    res.json({
      totalUsers: totalUsersResult.rows[0].count,
      activeUsersToday: 0,
      imagesGenerated: imagesResult.rows[0].count,
      creditsUsed: 0,
      storageUsed: "0 MB",
      chartData: []
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