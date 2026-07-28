-- Migration: TOTP multi-factor authentication for admin accounts (SEC-15.2).
--
-- Admin login was single-factor: one correct password string was the complete
-- authentication requirement for an account that can grant credits, rewrite
-- pricing and delete the catalog. A phished, reused or breached password
-- yielded full admin capability with nothing further in the way.
--
-- Opt-in per account (mfa_enabled) so enrollment can be rolled out one admin
-- at a time - see the operational notes in src/utils/mfaCrypto.js for why that
-- matters here specifically. Safe to run multiple times.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE admins
  -- AES-256-GCM ciphertext of the base32 TOTP secret, never the secret itself.
  -- Encrypted under MFA_ENCRYPTION_KEY (see src/utils/mfaCrypto.js): the secret
  -- is symmetric, so anyone who can read this column in plaintext could mint
  -- valid codes forever. NULL until enrollment.
  ADD COLUMN IF NOT EXISTS mfa_secret TEXT,

  -- The enforcement switch. Set only AFTER the admin has proved with a live
  -- code that their authenticator actually holds the secret, so enrollment can
  -- never lock someone out with a secret their phone never received.
  ADD COLUMN IF NOT EXISTS mfa_enabled BOOLEAN NOT NULL DEFAULT false,

  ADD COLUMN IF NOT EXISTS mfa_enrolled_at TIMESTAMPTZ,

  -- Replay protection. A TOTP code stays valid for its whole 30s step (plus the
  -- skew window), so a code observed in transit or over a shoulder is otherwise
  -- replayable for up to ~90s. Recording the consumed step and refusing to
  -- accept it again closes that window to a single use.
  ADD COLUMN IF NOT EXISTS mfa_last_timestep BIGINT;

-- Single-use recovery codes: the only way back in for an admin who loses their
-- authenticator. There is no admin password-reset flow anywhere in this
-- codebase, so without these the fallback for a lost device is direct database
-- access. Stored as bcrypt hashes at the same cost as admin passwords - they
-- are password-equivalent credentials and are treated as such.
CREATE TABLE IF NOT EXISTS admin_mfa_recovery_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id UUID NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Login looks up "this admin's unused codes"; nothing ever queries by hash
-- (each candidate is bcrypt-compared against the unused set).
CREATE INDEX IF NOT EXISTS idx_admin_mfa_recovery_admin
  ON admin_mfa_recovery_codes (admin_id) WHERE used_at IS NULL;

-- The backend reaches this table as the table owner over its direct Postgres
-- connection (bypasses RLS). Enabling RLS with no policies keeps Supabase's
-- auto-generated REST API from exposing recovery-code hashes to the anon or
-- authenticated keys. Same posture as admin_audit_log and notifications.
ALTER TABLE admin_mfa_recovery_codes ENABLE ROW LEVEL SECURITY;
