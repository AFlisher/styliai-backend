const { Client } = require('pg');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { buildSslConfig } = require('../config/db');
require('dotenv').config();

const MIGRATIONS_DIR = path.join(__dirname, '../..');

/**
 * SEC-21.1 (Phase 9) - the ledger migration, applied BEFORE the schedule.
 *
 * It cannot simply be appended to MIGRATIONS like every other migration,
 * because the runner records each application INTO it: the table has to exist
 * before the first row can be written, and appending it at the end would mean
 * the whole schedule ran unrecorded on a fresh database and only became
 * traceable from the next deploy onward - i.e. the one run where knowing what
 * happened matters most is the one run with no record of it.
 *
 * It is bootstrapped instead, and accounted for as its own category in the
 * completeness check below so the "every file on disk is accounted for"
 * guarantee is preserved rather than quietly gaining an exception.
 */
const LEDGER_MIGRATION = 'migration_schema_migrations.sql';

/**
 * Every migration that must run, in dependency order.
 *
 * This list is the schedule. It is NOT sorted alphabetically and must never be:
 * alphabetically, migration_admin_audit_log.sql sorts 29 places before
 * migration_wallet_ledger.sql, so its `ALTER TABLE wallet_transactions ADD
 * COLUMN admin_id` would run long before that table exists. migration_auto_tags
 * likewise sorts before migration_catalog, which creates the `styles` table it
 * reads. A glob-and-sort runner fails on a fresh database; this order is the
 * order these migrations were actually written and applied in.
 *
 * Ordering rules to preserve when appending:
 *   - migration.sql creates users + profiles; anything altering them follows it.
 *   - migration_admins.sql creates admins; the admin_* migrations follow it.
 *   - migration_catalog.sql creates styles; style_* and tag migrations follow it.
 *   - migration_wallet_ledger.sql creates wallet_transactions;
 *     migration_admin_audit_log.sql alters it, so it must come after.
 *
 * Append new migrations at the END. Do not reorder existing entries.
 */
const MIGRATIONS = [
  // --- Core schema -----------------------------------------------------------
  'migration.sql',                             // users, profiles
  'migration_google.sql',
  'migration_users_wallet_columns.sql',
  'migration_admins.sql',                      // admins
  'migration_catalog.sql',                     // categories, styles
  'migration_wallet_ledger.sql',               // wallet_transactions
  'migration_ad_transactions.sql',
  'migration_fix_wallet_transaction_type.sql',
  'migration_credit_packs.sql',
  'migration_favorites.sql',
  'migration_creations.sql',
  'migration_trending_index.sql',              // index on styles
  'migration_tags.sql',
  'migration_personalization.sql',
  'migration_seed_tags.sql',
  'migration_auto_tags.sql',                   // reads styles

  // --- Schema corrections and feature columns --------------------------------
  'migration_style_fields.sql',
  'migration_verification_token_hash.sql',     // renames users.verification_token
  'migration_notifications.sql',
  'migration_profile_bio.sql',
  'migration_style_image_counts.sql',
  'migration_country.sql',                     // users.country_code / country_name
  'migration_thumbnails.sql',
  'migration_generation_events.sql',
  'migration_generation_feedback.sql',

  // --- Security remediation --------------------------------------------------
  'migration_login_lockout.sql',               // SEC-1.3
  'migration_admin_roles.sql',                 // SEC-15.4
  'migration_admin_mfa.sql',                   // SEC-15.2 (references admins)
  'migration_admin_audit_log.sql',             // SEC-15.1 (alters wallet_transactions)
  'migration_integrity_verdicts.sql',          // SEC-0.4
  'migration_session_revocation.sql',           // Phase 6: SEC-1.4/1.5/15.3/18.2 + token_version
  'migration_generation_idempotency.sql',       // Phase 7: SEC-3.1 (references users)
  'migration_abuse_detection.sql',              // Phase 8: SEC-18.1/18.3/18.5 (alters users + refresh_tokens)

  // --- User Management & Moderation module -----------------------------------
  'migration_user_account_deletion.sql',        // adds 'deleted' to users_status_check (requires migration_session_revocation.sql)

  // --- Operations Center module ------------------------------------------------
  'migration_security_events.sql',              // persisted auth_failure/authz_failure history

  // --- System Health module ----------------------------------------------------
  'migration_system_health.sql'                 // system_incidents + backup_runs
];

/**
 * Migrations that exist in the repository but must NOT be replayed, with the
 * reason. They are listed here rather than deleted so the completeness check
 * below still accounts for every file on disk, and so the reason survives.
 */
const SUPERSEDED = {
  'migration_storage_avatar_read_policy.sql':
    'SEC-24.1, superseded by R-2 (2026-07-30). R-2 dropped every avatar RLS policy and made the ' +
    'bucket private; storage.objects is verified to carry zero policies. Replaying this would ' +
    're-create a policy that was deliberately removed.',
  'migration_storage_avatars.sql':
    'SEC-14.1 bucket MIME/size limits, superseded by R-2 (2026-07-30). Avatar uploads are now ' +
    'backend-mediated with magic-byte and decode validation. It also targets storage.buckets, ' +
    'which no migration provisions - buckets are created outside this runner (see below).'
};

/**
 * Fails if the repository and the schedule above have drifted apart.
 *
 * This is the check whose absence caused the original defect: the runner
 * applied 18 of 32 migration files, and nothing failed when the other 14 were
 * added without being listed. A fresh database was missing user registration
 * columns, the entire admin security layer, and every RLS statement in the repo.
 */
function assertScheduleIsComplete() {
  const onDisk = fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.startsWith('migration') && f.endsWith('.sql'))
    .sort();

  const accounted = new Set([...MIGRATIONS, ...Object.keys(SUPERSEDED), LEDGER_MIGRATION]);
  const unlisted = onDisk.filter((f) => !accounted.has(f));
  const missing = [...accounted].filter((f) => !onDisk.includes(f)).sort();

  const duplicates = MIGRATIONS.filter((f, i) => MIGRATIONS.indexOf(f) !== i);
  const bothLists = MIGRATIONS.filter((f) => f in SUPERSEDED);

  if (unlisted.length || missing.length || duplicates.length || bothLists.length) {
    console.error('❌ Migration schedule is out of sync with the repository.\n');
    if (unlisted.length) {
      console.error('   Present on disk but not scheduled - add each to MIGRATIONS (at the END,');
      console.error('   preserving the existing order) or to SUPERSEDED with a reason:');
      unlisted.forEach((f) => console.error(`     + ${f}`));
      console.error('');
    }
    if (missing.length) {
      console.error('   Scheduled but not present on disk - remove the entry or restore the file:');
      missing.forEach((f) => console.error(`     - ${f}`));
      console.error('');
    }
    if (duplicates.length) {
      console.error('   Listed more than once in MIGRATIONS:');
      [...new Set(duplicates)].forEach((f) => console.error(`     ! ${f}`));
      console.error('');
    }
    if (bothLists.length) {
      console.error('   Listed in both MIGRATIONS and SUPERSEDED:');
      bothLists.forEach((f) => console.error(`     ! ${f}`));
      console.error('');
    }
    console.error(`   On disk: ${onDisk.length} · scheduled: ${MIGRATIONS.length} · superseded: ${Object.keys(SUPERSEDED).length} · ledger: 1`);
    process.exit(1);
  }

  console.log(
    `✅ Schedule covers all ${onDisk.length} migration files ` +
    `(${MIGRATIONS.length} to apply, ${Object.keys(SUPERSEDED).length} superseded, 1 ledger).`
  );
}

/** SHA-256 of a migration file, as applied. See migration_schema_migrations.sql. */
function checksumOf(sql) {
  // LINE ENDINGS ARE NORMALISED BEFORE HASHING, and this is not cosmetic.
  //
  // This repository is developed on Windows with `core.autocrlf=true`, so git
  // materialises the SAME committed file with CRLF in one working tree and LF
  // in another (a git worktree, CI on Linux, a fresh clone with different
  // settings). Hashing the raw bytes therefore reported 21 migrations as
  // "edited after application" purely because the ledger was written from one
  // checkout and verified from another - which is exactly the failure the drift
  // check exists to prevent people ignoring: a check that is always red is a
  // check nobody reads.
  //
  // The property worth protecting is that the SQL is unchanged, not that the
  // bytes are identical, so the newline representation is normalised out.
  const normalized = String(sql).replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/**
 * SEC-21.1 - records an application in the ledger.
 *
 * NEVER THROWS INTO THE MIGRATION RUN, and that ordering is deliberate: the
 * ledger is bookkeeping ABOUT the schema, not part of it. A database that
 * received its DDL correctly but failed to write a ledger row is in a good
 * state with poor records; refusing the migration over it would turn a
 * bookkeeping problem into a failed deploy or, during recovery, a blocked
 * restore. It reports loudly instead.
 *
 * `applied_at` is set once and never updated - the fact worth keeping is when
 * this database FIRST received the change. Replays update `last_run_at`,
 * `run_count` and `duration_ms`.
 */
async function recordMigration(client, file, sql, durationMs) {
  try {
    const result = await client.query(
      `INSERT INTO schema_migrations (filename, checksum, duration_ms)
       VALUES ($1, $2, $3)
       ON CONFLICT (filename) DO UPDATE
         SET last_run_at = now(),
             run_count   = schema_migrations.run_count + 1,
             duration_ms = EXCLUDED.duration_ms
       RETURNING checksum AS "storedChecksum", run_count AS "runCount"`,
      [file, checksumOf(sql), durationMs]
    );
    return result.rows[0] || null;
  } catch (err) {
    console.warn(
      `   ⚠️  Could not record ${file} in schema_migrations: ${err.message}`
    );
    return null;
  }
}

async function runMigration() {
  if (!process.env.DATABASE_URL) {
    console.error("❌ ERROR: DATABASE_URL is not set in your .env file!");
    process.exit(1);
  }

  assertScheduleIsComplete();

  // Same TLS configuration as the application pool, so DATABASE_CA_CERT is
  // honored here too (SEC-10.2). Previously this script hardcoded
  // `rejectUnauthorized: false`, meaning the one process that ships DDL was the
  // one that did not verify the server certificate.
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: buildSslConfig()
  });

  let applied = 0;
  let connected = false;
  // SEC-21.1: migrations whose stored checksum no longer matches the file.
  const checksumDrift = [];

  try {
    await client.connect();
    connected = true;
    console.log("✅ Connected to database. Running migration script...");

    // SEC-21.1: bootstrap the ledger first, so every migration below - including
    // on a brand-new database - is recorded as it is applied.
    {
      const ledgerSql = fs.readFileSync(path.join(MIGRATIONS_DIR, LEDGER_MIGRATION), 'utf8');
      const startedAt = Date.now();
      await client.query(ledgerSql);
      await recordMigration(client, LEDGER_MIGRATION, ledgerSql, Date.now() - startedAt);
      console.log(`   [ledger] ✅ ${LEDGER_MIGRATION}`);
    }

    for (const file of MIGRATIONS) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');

      const startedAt = Date.now();
      await client.query(sql);
      const durationMs = Date.now() - startedAt;

      const record = await recordMigration(client, file, sql, durationMs);
      applied += 1;

      // SEC-21.1: the drift warning. A stored checksum that no longer matches
      // the file means an already-applied migration was EDITED afterwards -
      // against this project's own rule - so a rebuilt database will not
      // reproduce the schema that was backed up, and nothing else in the system
      // would ever say so. Warn rather than fail: the DDL just ran successfully,
      // and blocking a deploy (or a recovery) over a bookkeeping discrepancy is
      // the wrong trade. It is loud, and `npm run verify:restore` fails on it.
      if (record && record.storedChecksum && record.storedChecksum !== checksumOf(sql)) {
        checksumDrift.push(file);
      }

      console.log(`   [${String(applied).padStart(2)}/${MIGRATIONS.length}] ✅ ${file}`);
    }

    if (checksumDrift.length) {
      console.warn('\n⚠️  CHECKSUM DRIFT - these migrations were edited after they were first applied:');
      checksumDrift.forEach((f) => console.warn(`     ! ${f}`));
      console.warn('   A rebuilt database will NOT reproduce the schema that was backed up.');
      console.warn('   Migrations are append-only by policy; correct this with a NEW migration.');
    }

    if (Object.keys(SUPERSEDED).length) {
      console.log('\nℹ️  Skipped (superseded - see SUPERSEDED in this file for why):');
      Object.keys(SUPERSEDED).forEach((f) => console.log(`     ~ ${f}`));
    }

    console.log("\n✅ Database migration completed successfully!");
    console.log(
      "ℹ️  Note: this runner creates the SCHEMA only. Supabase Storage buckets " +
      "(creations, avatars, style-images) are provisioned outside it, so a rebuilt " +
      "database is not by itself a rebuilt system."
    );
  } catch (err) {
    if (!connected) {
      console.error("\n❌ Could not connect to the database:", err.message);
      console.error("   No migration was applied. The database is unchanged.");
    } else {
      console.error(`\n❌ Database migration failed on ${MIGRATIONS[applied]}:`, err.message);
      console.error(`   ${applied} of ${MIGRATIONS.length} migrations were applied before this failure.`);
      if (applied > 0) {
        console.error("   Migrations are not wrapped in a single transaction, so the database is");
        console.error("   partially migrated. Fix the cause and re-run - every migration is guarded");
        console.error("   (IF NOT EXISTS / DO $$ blocks), so re-running the earlier ones is a no-op.");
      } else {
        console.error("   The database is unchanged.");
      }
    }
    process.exitCode = 1;
  } finally {
    if (connected) await client.end();
  }
}

/**
 * SEC-21.2: run only when invoked directly (`npm run migrate`), not when
 * imported.
 *
 * The restore verifier needs the SCHEDULE - it is the source of truth for what
 * a correctly restored database must contain - and before this guard, importing
 * this file to read it would have connected to a database and applied 33
 * migrations as a side effect. That is a footgun in normal use and an actively
 * dangerous one in the recovery tooling, where the whole point is to INSPECT a
 * database without changing it.
 */
if (require.main === module) {
  runMigration();
}

module.exports = {
  MIGRATIONS,
  SUPERSEDED,
  LEDGER_MIGRATION,
  checksumOf,
  assertScheduleIsComplete,
  /** Every migration file the repository intends a database to have received. */
  allMigrationFiles: () => [LEDGER_MIGRATION, ...MIGRATIONS],
};
