-- Migration: server-side session revocation and enforcement (Phase 6).
--
-- Covers SEC-1.4 (refresh reuse detection), SEC-1.5 (verification token
-- expiry), SEC-15.3 (admin token revocation) and SEC-18.2 (user suspension),
-- plus the token_version mechanism the roadmap lists as the phase enabler.
--
-- Before this, both authMiddleware and adminAuthMiddleware verified a JWT
-- signature and nothing else - no database read - so nothing could be revoked
-- before the token's own `exp`. Logout, password change and password reset all
-- cleared users.refresh_token_hash, which stopped the NEXT refresh but left
-- every already-issued access token valid for up to an hour. There was no way
-- at all to stop an account mid-session.
--
-- Safe to run multiple times.

-- ---------------------------------------------------------------------------
-- 1. token_version: the global session epoch, per identity.
-- ---------------------------------------------------------------------------
-- Embedded in every access token as the `tv` claim and compared against this
-- column on every authenticated request. Incrementing it invalidates every
-- token ever issued for that identity, immediately, with no denylist to store
-- or expire. Starts at 0 so tokens minted before this migration - which carry
-- no `tv` claim and are read as 0 - keep working until the first bump.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;

ALTER TABLE admins
  ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 2. Account status: suspension that takes effect mid-session (SEC-18.2).
-- ---------------------------------------------------------------------------
-- Checked on the same read as token_version, so enforcing it costs nothing
-- extra. 'suspended' is reversible; 'banned' is the same enforcement with a
-- different operator intent recorded. Both stop existing sessions at once
-- rather than at next login, because an abusive session is exactly the one
-- that will not voluntarily re-authenticate.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS status_reason TEXT,
  ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS status_changed_by UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_status_check'
  ) THEN
    ALTER TABLE public.users
      ADD CONSTRAINT users_status_check
      CHECK (status IN ('active', 'suspended', 'banned'));
  END IF;
END
$$;

-- Suspended accounts are a small minority, so a partial index keeps the
-- "who is currently suspended" admin query cheap without carrying every
-- active row.
CREATE INDEX IF NOT EXISTS idx_users_status_not_active
  ON public.users (status)
  WHERE status <> 'active';

-- ---------------------------------------------------------------------------
-- 3. Email verification token expiry (SEC-1.5).
-- ---------------------------------------------------------------------------
-- verification_token_hash had no expiry column at all: a link mailed on day
-- one stayed valid forever, so an old mailbox compromise remained an account
-- takeover indefinitely.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS verification_token_expires_at TIMESTAMPTZ;

-- Backfill deliberately grants a FRESH 24 hours from deploy rather than
-- computing created_at + 24h. Anchoring to created_at would instantly expire
-- every pending link, mass-failing verification for users who registered
-- earlier today through no fault of their own; anchoring to now() closes the
-- unbounded window without invalidating a link that is currently in flight.
-- Only rows with a token pending are touched.
UPDATE public.users
SET verification_token_expires_at = now() + interval '24 hours'
WHERE verification_token_hash IS NOT NULL
  AND verification_token_expires_at IS NULL;

-- ---------------------------------------------------------------------------
-- 4. Refresh token families with reuse detection (SEC-1.4).
-- ---------------------------------------------------------------------------
-- Replaces the single users.refresh_token_hash column, which could hold
-- exactly one token per user and therefore could not tell "this token was
-- already exchanged" (theft) from "this token is simply not the current one"
-- (a stale client). Both looked identical: a hash mismatch.
--
-- One row per issued refresh token. Rotation marks the old row used and
-- inserts a successor in the SAME family. Presenting a row that is already
-- used is proof that two parties hold the same token - the legitimate client
-- and a thief - so the whole family is revoked and token_version is bumped.
--
-- token_hash is the PRIMARY KEY: the raw token is never stored, and the
-- lookup is the same SHA-256 hash used for reset and verification tokens.
CREATE TABLE IF NOT EXISTS refresh_tokens (
  token_hash   TEXT PRIMARY KEY,
  user_id      UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- Constant across a rotation chain. Revoking a family kills the thief's
  -- branch and the victim's branch together, which is intended: after a
  -- confirmed theft the correct outcome is that BOTH parties re-authenticate.
  family_id    UUID NOT NULL,
  issued_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  -- Non-null once exchanged. The reuse signal.
  used_at      TIMESTAMPTZ,
  -- Non-null once the family was revoked (logout, password change, suspension,
  -- or a detected reuse).
  revoked_at   TIMESTAMPTZ,
  revoked_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user
  ON refresh_tokens (user_id);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family
  ON refresh_tokens (family_id);

-- Supports the retention sweep below.
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires
  ON refresh_tokens (expires_at);

-- Backend-only table: the service role reaches it through the pg pool, never
-- PostgREST. RLS on with zero policies is default-deny for anon and
-- authenticated, matching migration_notifications.sql and
-- migration_integrity_verdicts.sql.
ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 5. Note on users.refresh_token_hash
-- ---------------------------------------------------------------------------
-- Deliberately NOT dropped. Sessions issued before this deploy hold a refresh
-- token whose hash lives only in that column; the refresh endpoint falls back
-- to it once and migrates the session into refresh_tokens. Dropping it here
-- would log out every existing user at deploy. It can be dropped in a later
-- migration once the longest legacy refresh token (30 days) has expired.
