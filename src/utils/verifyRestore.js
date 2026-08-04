const { Client } = require("pg");
const { buildSslConfig } = require("../config/db");
const expectations = require("./dr/schemaExpectations");
require("dotenv").config();

/**
 * SEC-21.2 - proves a database is actually usable, and says so with an exit
 * code.
 *
 * THE FINDING: "An untested backup is a hypothesis, not a control." The audit
 * asks for one real restore into a scratch project, which is an operator action
 * this repository cannot perform. What the repository CAN provide - and what
 * turns that exercise from a judgement call into a pass/fail - is the check you
 * run once the restore finishes: *is this schema complete, does it match the
 * repository, and are the constraints that silently protect money still there?*
 *
 * READ-ONLY BY CONSTRUCTION. Every statement below is a SELECT against
 * catalogue views. There is no DDL, no DML, and no transaction that could
 * modify anything, which is why this is safe to point at production - and
 * pointing it at production is a genuinely useful thing to do, because "is the
 * live schema complete?" is the same question. It is the RESTORE that is
 * dangerous, and restoring is deliberately NOT automated here (see the runbook):
 * a script that can overwrite a database is a script that will eventually
 * overwrite the wrong one.
 *
 * Usage:
 *   node src/utils/verifyRestore.js                 # verifies DATABASE_URL
 *   node src/utils/verifyRestore.js "postgres://…"  # verifies a scratch target
 */

const CHECK = { PASS: "PASS", FAIL: "FAIL", WARN: "WARN" };

function line(status, name, detail) {
  const icon = status === CHECK.PASS ? "✅" : status === CHECK.WARN ? "⚠️ " : "❌";
  console.log(`${icon} ${name}${detail ? ` — ${detail}` : ""}`);
}

/**
 * Every table the repository's migrations create must exist.
 *
 * Missing tables are the loud failure - the app breaks on first request - but
 * they are checked first because everything below is meaningless without them,
 * and because a partially-restored database is a real outcome (the runner
 * applies migrations outside a single transaction, and says so on failure).
 */
async function checkTables(client, results) {
  const expected = expectations.expectedTables();
  const { rows } = await client.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
  );
  const present = new Set(rows.map((r) => r.table_name.toLowerCase()));
  const missing = expected.filter((t) => !present.has(t));

  if (missing.length) {
    results.push({ status: CHECK.FAIL, name: "Tables", detail: `missing: ${missing.join(", ")}` });
  } else {
    results.push({ status: CHECK.PASS, name: "Tables", detail: `all ${expected.length} present` });
  }
}

/**
 * The ledger must account for every migration the repository schedules.
 *
 * This is the check that only exists because of SEC-21.1's second half. Before
 * the ledger, "is this schema current?" could only be answered by reading DDL
 * against 35 files by hand, under outage pressure.
 */
async function checkLedger(client, results) {
  const scheduled = expectations.scheduledMigrations();

  const exists = await client.query(
    `SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'schema_migrations'`
  );
  if (exists.rows.length === 0) {
    results.push({
      status: CHECK.FAIL,
      name: "Migration ledger",
      detail: "schema_migrations does not exist — run `npm run migrate`",
    });
    return;
  }

  const { rows } = await client.query(
    `SELECT filename, checksum FROM schema_migrations`
  );
  const applied = new Map(rows.map((r) => [r.filename, r.checksum]));
  const missing = scheduled.filter((f) => !applied.has(f));

  if (missing.length) {
    results.push({
      status: CHECK.FAIL,
      name: "Migration ledger",
      detail: `${missing.length} never applied: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "…" : ""}`,
    });
  } else {
    results.push({
      status: CHECK.PASS,
      name: "Migration ledger",
      detail: `all ${scheduled.length} recorded`,
    });
  }

  // Checksum drift: an already-applied migration was edited afterwards, so a
  // rebuilt database will not reproduce the schema that was backed up. FAIL
  // rather than WARN here (the runner only warns): the runner's job is to
  // apply DDL and it just succeeded, whereas this script's entire job is to say
  // whether the database matches the repository - and it does not.
  const drifted = [];
  for (const [filename, checksum] of applied) {
    if (!scheduled.includes(filename)) continue;
    let current;
    try {
      current = expectations.fileChecksum(filename);
    } catch (_) {
      continue; // file removed from repo; covered by the runner's drift check
    }
    if (current !== checksum) drifted.push(filename);
  }

  if (drifted.length) {
    results.push({
      status: CHECK.FAIL,
      name: "Migration checksums",
      detail: `edited after application: ${drifted.join(", ")}`,
    });
  } else {
    results.push({ status: CHECK.PASS, name: "Migration checksums", detail: "all match the repository" });
  }
}

/**
 * Constraints whose absence is SILENT.
 *
 * This is the check that justifies the whole script. A restore that loses a
 * table announces itself immediately; a restore that loses
 * `daily_rewards`'s UNIQUE constraint produces a system that runs perfectly and
 * hands out unlimited daily credits. Nothing else in the stack would notice.
 */
async function checkCriticalConstraints(client, results) {
  const { rows } = await client.query(
    `SELECT tc.table_name, tc.constraint_type
       FROM information_schema.table_constraints tc
      WHERE tc.table_schema = 'public'
        AND tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE')`
  );
  const have = new Set(rows.map((r) => `${r.table_name.toLowerCase()}::${r.constraint_type}`));

  const missing = expectations.CRITICAL_CONSTRAINTS.filter(
    (c) => !have.has(`${c.table}::${c.type}`)
  );

  if (missing.length) {
    for (const c of missing) {
      results.push({
        status: CHECK.FAIL,
        name: `Constraint ${c.table} ${c.type}`,
        detail: `MISSING — ${c.why}`,
      });
    }
  } else {
    results.push({
      status: CHECK.PASS,
      name: "Critical constraints",
      detail: `all ${expectations.CRITICAL_CONSTRAINTS.length} present`,
    });
  }
}

/** Indexes that bound cost rather than merely improve it. */
async function checkCriticalIndexes(client, results) {
  const { rows } = await client.query(
    `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`
  );
  const have = new Set(rows.map((r) => r.indexname.toLowerCase()));
  const missing = expectations.CRITICAL_INDEXES.filter((i) => !have.has(i.name.toLowerCase()));

  if (missing.length) {
    // WARN, not FAIL: a missing index degrades rather than breaks, and the
    // distinction matters during a recovery where the decision is "can I turn
    // this on now, and fix the rest afterwards?".
    results.push({
      status: CHECK.WARN,
      name: "Critical indexes",
      detail: `missing: ${missing.map((i) => `${i.name} (${i.why})`).join("; ")}`,
    });
  } else {
    results.push({
      status: CHECK.PASS,
      name: "Critical indexes",
      detail: `all ${expectations.CRITICAL_INDEXES.length} present`,
    });
  }
}

/**
 * Reports row counts for the tables that carry irreplaceable data.
 *
 * Deliberately NEVER a pass/fail on a threshold. This script cannot know what
 * "enough rows" means - a restore to an intentionally old point legitimately has
 * fewer - so asserting a minimum would produce confident nonsense. It prints
 * them so a human can compare against what they expected, which is the only
 * party able to make that judgement.
 */
async function reportRowCounts(client, results) {
  const tables = ["users", "creations", "wallet_transactions", "daily_rewards", "styles"];
  const counts = [];
  for (const t of tables) {
    try {
      const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${t}`);
      counts.push(`${t}=${rows[0].n}`);
    } catch (_) {
      counts.push(`${t}=<missing>`);
    }
  }
  results.push({ status: CHECK.PASS, name: "Row counts (informational)", detail: counts.join(" ") });
}

/**
 * Storage is a SEPARATE system and a database restore does not touch it.
 *
 * Stated as an explicit check rather than left to the runbook, because this is
 * the mistake that produces a "successful" recovery in which every user's
 * gallery 404s: the rows are restored and point at objects that no longer
 * exist. SEC-21.3 is the other half of the recovery unit.
 */
function remindStorage(results) {
  results.push({
    status: CHECK.WARN,
    name: "Storage pairing (SEC-21.3)",
    detail:
      "a DB restore does NOT restore Supabase Storage — verify the object backup " +
      "for the same point in time, or creation rows will reference missing images",
  });
}

async function verify(connectionString) {
  const target = connectionString || process.env.DATABASE_URL;
  if (!target) {
    console.error("❌ No target. Pass a connection string or set DATABASE_URL.");
    process.exitCode = 1;
    return { ok: false };
  }

  const client = new Client({ connectionString: target, ssl: buildSslConfig() });
  const results = [];

  try {
    await client.connect();
  } catch (err) {
    console.error(`❌ Could not connect to the target database: ${err.message}`);
    process.exitCode = 1;
    return { ok: false };
  }

  try {
    console.log("Restore verification — read-only, nothing is modified.\n");
    await checkTables(client, results);
    await checkLedger(client, results);
    await checkCriticalConstraints(client, results);
    await checkCriticalIndexes(client, results);
    await reportRowCounts(client, results);
    remindStorage(results);
  } finally {
    await client.end();
  }

  for (const r of results) line(r.status, r.name, r.detail);

  const failures = results.filter((r) => r.status === CHECK.FAIL);
  const warnings = results.filter((r) => r.status === CHECK.WARN);

  console.log("");
  if (failures.length) {
    console.log(`❌ NOT USABLE — ${failures.length} check(s) failed, ${warnings.length} warning(s).`);
    console.log("   Do not point the application at this database.");
    process.exitCode = 1;
    return { ok: false, results };
  }

  console.log(`✅ Schema verified — ${results.length - warnings.length} passed, ${warnings.length} warning(s).`);
  console.log("   Warnings are degradations, not blockers; read them before going live.");
  return { ok: true, results };
}

if (require.main === module) {
  verify(process.argv[2]).catch((err) => {
    console.error(`❌ Verification aborted: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { verify, CHECK, checkTables, checkLedger, checkCriticalConstraints, checkCriticalIndexes };
