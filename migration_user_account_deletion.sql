-- Migration: admin-initiated account deletion (User Management & Moderation module).
--
-- Adds 'deleted' as a fourth value alongside the existing 'active' / 'suspended'
-- / 'banned' set from migration_session_revocation.sql. Deliberately a status
-- value, not a row deletion: a real `DELETE FROM users` would cascade into
-- `profiles` (ON DELETE CASCADE) and orphan every foreign key that isn't -
-- wallet_transactions, creations, generation_events, abuse_findings, admin
-- audit rows - destroying financial and moderation history that has no
-- recovery path. 'deleted' reuses the exact same enforcement adminController's
-- setUserStatus already gives 'suspended'/'banned': status flips, token_version
-- bumps, every refresh token is revoked, and authController's generic
-- `status !== ACTIVE_STATUS` check (authController.js:470, :571, :1015) already
-- blocks login/refresh/Google sign-in for ANY non-active status, so 'deleted'
-- is refused with zero changes to that code path.
--
-- Safe to run multiple times.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_status_check'
  ) THEN
    ALTER TABLE public.users DROP CONSTRAINT users_status_check;
  END IF;

  ALTER TABLE public.users
    ADD CONSTRAINT users_status_check
    CHECK (status IN ('active', 'suspended', 'banned', 'deleted'));
END
$$;
