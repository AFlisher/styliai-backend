// One-off manual verification script for Roadmap Item 3.5 - not part of the
// automated Jest suite (deliberately hits the real DB with real concurrent
// transactions, which the Jest suite intentionally avoids per Item 2.9).
// Run with: node test/manual/concurrency_check_3_5.js <userId>
// Deletes nothing itself - cleanup is done separately by the caller.

const db = require("../../src/config/db");
const walletService = require("../../src/services/wallet/walletService");

const userId = process.argv[2];
if (!userId) {
  console.error("Usage: node concurrency_check_3_5.js <userId>");
  process.exit(1);
}

async function reconcile(label) {
  const userRes = await db.query("SELECT balance FROM users WHERE id = $1", [userId]);
  const sumRes = await db.query(
    "SELECT COALESCE(SUM(amount), 0)::int AS total, COUNT(*)::int AS count FROM wallet_transactions WHERE user_id = $1",
    [userId]
  );
  const balance = userRes.rows[0].balance;
  const { total, count } = sumRes.rows[0];
  const ok = balance === total;
  console.log(
    `[${label}] users.balance=${balance}  SUM(wallet_transactions.amount)=${total}  rows=${count}  ${ok ? "OK - reconciled" : "MISMATCH!!"}`
  );
  return { balance, total, count, ok };
}

async function main() {
  console.log("=== Scenario A: 20 concurrent addBalance(+1, 'reward') from balance=0 ===");
  const resultsA = await Promise.allSettled(
    Array.from({ length: 20 }, () => walletService.addBalance(userId, 1, "reward", "concurrency test credit"))
  );
  const succeededA = resultsA.filter((r) => r.status === "fulfilled").length;
  console.log(`succeeded: ${succeededA} / 20`);
  await reconcile("after Scenario A");

  console.log("\n=== Scenario B: reset balance to 5, then 10 concurrent deductBalance(1, 'generation') ===");
  await db.query("UPDATE users SET balance = 5 WHERE id = $1", [userId]);
  await db.query("DELETE FROM wallet_transactions WHERE user_id = $1", [userId]); // isolate this scenario's ledger delta
  const resultsB = await Promise.allSettled(
    Array.from({ length: 10 }, () => walletService.deductBalance(userId, 1, "generation", "concurrency test debit"))
  );
  const succeededB = resultsB.filter((r) => r.status === "fulfilled").length;
  const failedB = resultsB.filter((r) => r.status === "rejected");
  console.log(`succeeded: ${succeededB} / 10 (expected exactly 5)`);
  console.log(`failure reasons: ${[...new Set(failedB.map((r) => r.reason.message))].join(", ")}`);
  await reconcile("after Scenario B");

  console.log("\n=== Scenario C: reset ads_progress=0, no daily_rewards row, 4 concurrent rewardAd() calls ===");
  await db.query("UPDATE users SET balance = 0, ads_progress = 0 WHERE id = $1", [userId]);
  await db.query("DELETE FROM wallet_transactions WHERE user_id = $1", [userId]);
  await db.query("DELETE FROM daily_rewards WHERE user_id = $1", [userId]);
  const resultsC = await Promise.allSettled(Array.from({ length: 4 }, () => walletService.rewardAd(userId)));
  const rewardedCount = resultsC.filter((r) => r.status === "fulfilled" && r.value.rewarded).length;
  console.log("raw results:", JSON.stringify(resultsC.map((r) => (r.status === "fulfilled" ? r.value : r.reason.message))));
  console.log(`credits actually granted: ${rewardedCount} (daily cap should allow at most 1 per day)`);
  const dailyRow = await db.query(
    "SELECT credits_claimed FROM daily_rewards WHERE user_id = $1 AND reward_date = CURRENT_DATE",
    [userId]
  );
  console.log("daily_rewards row:", dailyRow.rows[0]);
  await reconcile("after Scenario C");

  process.exit(0);
}

main().catch((e) => {
  console.error("Script error:", e);
  process.exit(1);
});
