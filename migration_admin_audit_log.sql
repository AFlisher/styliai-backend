-- Migration: admin_audit_log — accountability trail for privileged admin
-- actions (SEC-15.1).
--
-- Before this table, admin identity existed only in memory: adminAuthMiddleware
-- decoded the JWT into req.admin and every handler then mutated without
-- recording who was acting. wallet_transactions carried type='admin' but no
-- actor, so a credit grant was unattributable; catalog, pricing and storage
-- mutations recorded nothing at all.
--
-- Safe to run multiple times.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Deliberately NOT a foreign key to admins(id). An audit row has to survive
  -- deletion of the admin who wrote it, and the insert must never fail because
  -- the actor row is gone - an audit trail that can be erased by deleting the
  -- account is not an audit trail. admin_email is a snapshot taken from the
  -- verified JWT at action time, so attribution stays human-readable even
  -- after the admins row changes or disappears.
  admin_id UUID NOT NULL,
  admin_email TEXT,

  -- Route-shaped, e.g. 'DELETE /api/styles/:id'. Stable across ids, so
  -- "everything this admin deleted" is one indexed query.
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,

  -- before: the row as it existed prior to a destructive action (deletes
  -- capture the full row via RETURNING *), or the pre-adjustment balance.
  -- after:  the admin's submitted payload (create/update), or the
  --         post-adjustment balance.
  -- Both are byte-capped and key-filtered by src/models/adminAuditModel.js -
  -- see there for why.
  before JSONB,
  after JSONB,

  -- req.ip, correct because app.js sets 'trust proxy' to the verified hop
  -- count (2) rather than a permissive value.
  ip TEXT,
  request_url TEXT,
  status_code INTEGER,

  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The two questions this table gets asked: "what happened recently?" and
-- "what did this admin do?".
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created_at
  ON admin_audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_admin_created
  ON admin_audit_log (admin_id, created_at DESC);

-- The backend reads/writes this table over its direct Postgres connection
-- (table owner, bypasses RLS). Enabling RLS with no policies keeps Supabase's
-- auto-generated REST API from exposing the table to the anon/authenticated
-- keys - without this the audit log would publish admin emails, target user
-- ids and balance before/after to anyone holding the public anon key.
-- Same posture as notifications (migration_notifications.sql).
ALTER TABLE admin_audit_log ENABLE ROW LEVEL SECURITY;

-- SEC-15.1: stamp the acting admin on manual balance adjustments. Nullable
-- because the vast majority of ledger rows are user-driven (generation,
-- reward, refund) and have no admin actor; only type='admin' rows populate it.
ALTER TABLE wallet_transactions
  ADD COLUMN IF NOT EXISTS admin_id UUID;
