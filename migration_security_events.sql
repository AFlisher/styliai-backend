-- Migration: security_events — persisted history for the security-event
-- vocabulary in src/utils/securityEvents.js (Operations Center module).
--
-- Before this table, logAuthFailure/logAuthzFailure/etc. only ever wrote to
-- the log stream (README's tracked gap SEC-16.5: "logs are emitted
-- structurally but never shipped, retained or alerted on"). This gives the
-- two highest-signal categories — failed authentication and authorization
-- refusals — a queryable, bounded history, without turning every routine
-- validation rejection into a persisted row (those stay log-only; see
-- securityEvents.js for which functions write here).
--
-- Deliberately separate from admin_audit_log: that table is the
-- accountability record for privileged admin MUTATIONS. This one is the
-- record of REFUSALS — attempts that did not succeed — which can originate
-- from unauthenticated traffic that never acquires an admin_id or user_id.
--
-- Safe to run multiple times.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS security_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 'auth_failure' | 'authz_failure' today; the CHECK is a soft catalog, not a
  -- hard boundary — a new securityEvents.js category can extend it later via
  -- a follow-up migration without breaking existing rows.
  event_type TEXT NOT NULL CHECK (event_type IN ('auth_failure', 'authz_failure')),

  -- Short fixed label the caller chose (e.g. "unknown_email",
  -- "account_locked_threshold_reached") — never a raw error message or the
  -- credential itself. Same discipline securityEvents.js already documents.
  reason TEXT,

  -- Free-form identifier the caller supplied for "who/what this was about"
  -- (usually a user or admin id as a string). Kept separate from user_id/
  -- admin_id below, which are only populated when that value is a real UUID
  -- from an authenticated session — subject may be neither.
  subject TEXT,

  method TEXT,
  endpoint TEXT,
  ip TEXT,

  -- Populated only when the request carried a verified identity at the time
  -- of the event (req.user.id / req.admin.id) — NOT copied from `subject`,
  -- so an attacker-supplied value can never masquerade as an attributed
  -- actor. Not foreign keys, for the same reason admin_audit_log.admin_id
  -- isn't: the event must survive deletion of the account it names.
  user_id UUID,
  admin_id UUID,

  request_id TEXT,

  -- Any additional structured context (e.g. required/actual role for an
  -- authz failure). Sanitized and size-capped by
  -- adminAuditModel.sanitizePayload before it reaches this column — same
  -- credential-redaction rule as admin_audit_log.
  detail JSONB,

  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_security_events_created_at
  ON security_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_events_type_created
  ON security_events (event_type, created_at DESC);

-- Same posture as admin_audit_log: RLS enabled with zero policies so
-- Supabase's auto-generated REST API never exposes this table to the anon/
-- authenticated keys. The backend reads/writes over its direct Postgres
-- connection as table owner, which bypasses RLS.
ALTER TABLE security_events ENABLE ROW LEVEL SECURITY;
