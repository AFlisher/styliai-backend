-- Migration: the schema_migrations ledger (Phase 9, SEC-21.1 remainder).
--
-- WHAT THIS CLOSES. SEC-21.1 had two halves. The first - "the runner applies 18
-- of 25 migration files, and nothing failed when the other 7 were added without
-- being listed" - was fixed in `ba6bbd3` with an explicit schedule plus a
-- drift assertion that refuses to run when the repository and the schedule
-- disagree. The second half is this: *"There is **no `schema_migrations` (or
-- equivalent) tracking table** in any migration or in the runner, so no
-- database records which migrations it has received."*
--
-- WHY THAT MATTERS SPECIFICALLY FOR RECOVERY, which is why it sits in the DR
-- phase rather than with general migration hygiene: after a restore, the one
-- question that has to be answered before the app is pointed at the database is
-- "is this schema complete, and complete as of WHEN?". Without a ledger the
-- only way to answer it is to inspect the schema by hand against 35 files,
-- under outage pressure, which is precisely the condition under which nobody
-- should be reading DDL. With a ledger it is one SELECT, and
-- `npm run verify:restore` turns it into an exit code.
--
-- THE CHECKSUM IS THE PART THAT EARNS ITS PLACE. Recording *that* a migration
-- ran is useful; recording *what ran* is what catches the failure this project
-- is actually exposed to. The house rule is "never edit an old migration", and
-- a rule enforced only by discipline is a rule that fails silently: an edited
-- migration replays differently on a rebuilt database than it did on
-- production, so the restored schema diverges from the one that was backed up
-- and nothing anywhere says so. Storing the SHA-256 of the file as applied
-- turns that from an invisible divergence into a loud warning.
--
-- Safe to run multiple times.

CREATE TABLE IF NOT EXISTS schema_migrations (
  -- The filename is the identity. Not a serial version number: this project's
  -- ordering is an explicit dependency-ordered schedule in runMigration.js, not
  -- a lexical or timestamp sequence (alphabetically, migration_admin_audit_log
  -- sorts 29 places before the wallet_transactions table it ALTERs), so a
  -- numeric "version" would imply an ordering the project deliberately does not
  -- have.
  filename    TEXT PRIMARY KEY,

  -- SHA-256 of the file contents at the moment it was applied.
  checksum    TEXT NOT NULL,

  -- First application. Deliberately NOT updated on replay - the interesting
  -- fact for recovery is when this database first received the change.
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Last replay, and how many times. Migrations here are idempotent and are
  -- re-run on every deploy, so a replay count is normal and expected; it is
  -- recorded because "this migration has never been replayed since the incident"
  -- is occasionally the fact you need.
  last_run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  run_count   INTEGER NOT NULL DEFAULT 1,

  -- Wall-clock milliseconds of the most recent application. Cheap to record and
  -- it is the raw material for an honest RTO: SEC-21.2 asks for a measured
  -- schema-rebuild time, and this is where that measurement comes from rather
  -- than from a guess.
  duration_ms INTEGER
);

-- "What did this database receive, in what order" - the restore-verification
-- query. Ordered by first application, which reconstructs the actual sequence
-- rather than the intended one.
CREATE INDEX IF NOT EXISTS idx_schema_migrations_applied
  ON schema_migrations (applied_at);

COMMENT ON TABLE schema_migrations IS
  'SEC-21.1: ledger of applied migrations. `checksum` is the SHA-256 of the '
  'file as applied - a mismatch means an old migration was edited after the '
  'fact, which makes a rebuilt schema diverge silently from the one that was '
  'backed up. Replay is normal: migrations are idempotent and re-run on every '
  'deploy. Read by `npm run verify:restore`.';
