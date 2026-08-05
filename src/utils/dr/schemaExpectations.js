const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/**
 * SEC-21.2 - what a correctly restored database must contain.
 *
 * WHY THIS IS DERIVED, NOT HAND-WRITTEN. The obvious implementation is a
 * checked-in list of expected tables. That list is wrong the moment someone
 * adds a migration and forgets to update it - and it fails in the worst
 * direction: a restore verification that passes because the expectation drifted
 * to match the gap is worse than no verification, because it is believed.
 *
 * So the migration SCHEDULE is the source of truth (it already has a drift
 * assertion of its own, SEC-21.1), and the table list is extracted from the
 * migration SQL itself. Adding a migration that creates a table automatically
 * extends what a restore is checked against, with nothing to remember.
 *
 * The critical-object list below is the one hand-maintained part, and it is
 * deliberately short: objects whose ABSENCE would be silently dangerous rather
 * than loudly broken. A missing table breaks the app on the first request; a
 * missing UNIQUE constraint breaks nothing visibly and quietly re-enables a
 * double-spend.
 */

const REPO_ROOT = path.join(__dirname, "../../..");

/** Reads the runner's schedule without executing it. */
function scheduledMigrations() {
  const runner = require("../runMigration");
  return runner.allMigrationFiles();
}

/**
 * SHA-256 of a migration file as it exists in the repository right now.
 *
 * MUST match runMigration.checksumOf exactly, including its line-ending
 * normalisation — the two are compared against each other, so any divergence
 * makes the drift check report every migration as edited. It is computed here
 * rather than imported so this module stays usable without pulling in the
 * runner, and a test pins the two implementations together for exactly that
 * reason.
 */
function fileChecksum(filename) {
  const sql = fs.readFileSync(path.join(REPO_ROOT, filename), "utf8");
  const normalized = String(sql).replace(/\r\n/g, "\n");
  return crypto.createHash("sha256").update(normalized, "utf8").digest("hex");
}

/**
 * Removes SQL comments so prose cannot be mistaken for DDL.
 *
 * This is not defensive tidying - it fixed a real false positive. These
 * migrations are heavily commented, and `migration_ad_transactions.sql`
 * contains the sentence "...CREATE TABLE IF NOT EXISTS on every
 * /api/wallet/reward/verify call", from which the extractor happily derived a
 * required table named `on`. A restore verifier that demands a table nobody
 * will ever create fails permanently, and a check that is always red is a check
 * that gets ignored - the precise failure mode this tooling exists to avoid.
 */
function stripSqlComments(sql) {
  return String(sql)
    .replace(/\/\*[\s\S]*?\*\//g, " ")  // block comments
    .replace(/--[^\n\r]*/g, " ");        // line comments
}

/**
 * Extracts table names from `CREATE TABLE IF NOT EXISTS x` / `CREATE TABLE x`.
 *
 * Deliberately ignores `ALTER TABLE`: a migration that alters a table does not
 * assert the table is its responsibility, and treating it as a creator would
 * produce expectations for tables created outside this repository.
 */
function tablesCreatedBy(sql) {
  const out = new Set();
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?["']?([a-zA-Z_][a-zA-Z0-9_]*)["']?/gi;
  let m;
  const cleaned = stripSqlComments(sql);
  while ((m = re.exec(cleaned)) !== null) out.add(m[1].toLowerCase());
  return out;
}

/** Every table the repository's migrations claim to create. */
function expectedTables() {
  const tables = new Set();
  for (const file of scheduledMigrations()) {
    const sql = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
    for (const t of tablesCreatedBy(sql)) tables.add(t);
  }
  return [...tables].sort();
}

/**
 * Objects whose absence is SILENT rather than loud.
 *
 * Each entry names the finding that made it load-bearing, because a future
 * reader deciding whether an item still matters needs to know what it was
 * defending. Losing any of these in a restore produces a system that appears to
 * work and is quietly wrong - which is the only failure mode a restore
 * verification can usefully catch, since the loud ones announce themselves.
 */
const CRITICAL_CONSTRAINTS = [
  // SEC-3.1: without this, the idempotency claim is not exclusive and a retry
  // charges twice - the exact defect Phase 7 closed.
  { table: "generation_idempotency", type: "PRIMARY KEY", why: "SEC-3.1 duplicate-charge protection" },
  // §4: one reward per user per day. A missing UNIQUE re-opens unlimited daily
  // claims, and nothing would look broken.
  { table: "daily_rewards", type: "UNIQUE", why: "SEC-4.x one reward per user per day" },
  // §5: AdMob SSV replay protection is a primary key on the transaction id.
  { table: "processed_ad_transactions", type: "PRIMARY KEY", why: "SEC-5.x SSV replay protection" },
  // Phase 6: refresh-token reuse detection keys on the token hash.
  { table: "refresh_tokens", type: "PRIMARY KEY", why: "SEC-1.4 refresh reuse detection" },
];

/**
 * Indexes that are load-bearing for BOUNDS rather than merely for speed.
 *
 * SEC-19.2's keyset pagination drives `idx_creations_user_created` directly; if
 * it is missing after a restore the query still returns correct results, so
 * nothing fails - it just degrades to a scan that gets slower with every row,
 * which is precisely the class of problem §19 existed to remove.
 */
const CRITICAL_INDEXES = [
  { name: "idx_creations_user_created", why: "SEC-19.2 keyset pagination" },
  { name: "idx_wallet_user_created", why: "wallet history bounds" },
  { name: "idx_abuse_findings_dedupe", why: "SEC-18.1 finding idempotency" },
];

module.exports = {
  REPO_ROOT,
  scheduledMigrations,
  fileChecksum,
  tablesCreatedBy,
  stripSqlComments,
  expectedTables,
  CRITICAL_CONSTRAINTS,
  CRITICAL_INDEXES,
};
