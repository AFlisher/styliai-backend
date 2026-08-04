const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
const { buildSslConfig } = require('../config/db');
require('dotenv').config();

const MIGRATIONS_DIR = path.join(__dirname, '../..');

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
  'migration_integrity_verdicts.sql'           // SEC-0.4
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

  const accounted = new Set([...MIGRATIONS, ...Object.keys(SUPERSEDED)]);
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
    console.error(`   On disk: ${onDisk.length} · scheduled: ${MIGRATIONS.length} · superseded: ${Object.keys(SUPERSEDED).length}`);
    process.exit(1);
  }

  console.log(
    `✅ Schedule covers all ${onDisk.length} migration files ` +
    `(${MIGRATIONS.length} to apply, ${Object.keys(SUPERSEDED).length} superseded).`
  );
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

  try {
    await client.connect();
    connected = true;
    console.log("✅ Connected to database. Running migration script...");

    for (const file of MIGRATIONS) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query(sql);
      applied += 1;
      console.log(`   [${String(applied).padStart(2)}/${MIGRATIONS.length}] ✅ ${file}`);
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

runMigration();
