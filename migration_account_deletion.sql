-- Migration: durable erasure record for self-service account deletion.
--
-- Sprint 1 / Release Blocker B-1. Google Play and App Store Guideline 5.1.1(v)
-- both require an in-app account deletion path; GDPR Art. 17 requires the
-- erasure itself, and Art. 5(2) requires being able to DEMONSTRATE it happened.
-- Those are two different obligations, and the second one is why this table
-- exists: once the user row is gone, nothing else in this database remembers
-- that the account ever existed, so an "did you actually delete my data?"
-- enquiry - from the user, a store reviewer, or a regulator - would have no
-- answer beyond a log line that has long since rotated away.
--
-- WHAT THIS TABLE DELIBERATELY DOES NOT HOLD
--
-- No email, no name, no IP, no avatar URL, no prompt text, no device data.
-- Retaining any of those would defeat the erasure this row exists to attest to.
-- What is left is a dangling UUID plus counts and timestamps: enough to answer
-- "was this account erased, when, and how much was removed", and worthless to
-- anyone who obtains it, because there is no longer a record anywhere that maps
-- that UUID back to a person.
--
-- NO FOREIGN KEY, and that is the whole point. `user_id` must outlive
-- public.users(id) - an FK would either cascade this row away with the account
-- (destroying the evidence at the moment it becomes relevant) or block the
-- deletion entirely. It is a historical identifier, not a live reference.
--
-- Safe to run multiple times.

CREATE TABLE IF NOT EXISTS account_deletions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The erased account's id. Intentionally FK-free (see above). Not UNIQUE:
  -- a UUID is never reissued, so a second row for the same id would itself be
  -- a signal worth seeing rather than a constraint violation to suppress.
  user_id UUID NOT NULL,

  deleted_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- How the deletion was initiated. Today only 'self_service_api' is written.
  -- Present so an operator- or support-initiated erasure can be told apart from
  -- a user-initiated one without a schema change.
  requested_via TEXT NOT NULL DEFAULT 'self_service_api',

  -- Counts, not contents. These are what make the row an attestation rather
  -- than a bare timestamp: "0 creations removed" and "41 creations removed"
  -- are very different answers to the same question.
  creations_deleted INTEGER NOT NULL DEFAULT 0,
  storage_objects_deleted INTEGER NOT NULL DEFAULT 0,

  -- Set when post-commit storage erasure did not fully succeed. The database
  -- rows are gone either way - this flags the account whose objects need
  -- `npm run reconcile-creations` attention, so a partial erasure is visible
  -- instead of silently looking complete.
  storage_erasure_complete BOOLEAN NOT NULL DEFAULT TRUE
);

-- Erasure enquiries arrive as "this user id, was it deleted?" and audits arrive
-- as "everything deleted in this window". Both are served by these two.
CREATE INDEX IF NOT EXISTS idx_account_deletions_user
  ON account_deletions (user_id);

CREATE INDEX IF NOT EXISTS idx_account_deletions_deleted_at
  ON account_deletions (deleted_at DESC);

COMMENT ON TABLE account_deletions IS
  'Sprint 1 / B-1: PII-free attestation that an account was erased. user_id is '
  'deliberately FK-free so the record outlives public.users. Holds no email, '
  'name, IP or content - only counts and timestamps.';

COMMENT ON COLUMN account_deletions.storage_erasure_complete IS
  'FALSE when post-commit object erasure failed; the account rows are gone '
  'regardless. Reconcile with npm run reconcile-creations.';
