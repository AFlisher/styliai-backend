-- Migration: system_incidents + backup_runs — persistence for the System
-- Health admin module.
--
-- system_incidents gives providerErrorLog.js's image-generation-provider
-- errors a queryable history (SEC-20.1/20.2: "no crash reporting; no
-- AI-provider error rate" was previously open — the log line itself is
-- unchanged, this adds a second, persisted write of the same already-
-- sanitized fields). Scoped to one source today ('image_provider'); the
-- CHECK is a soft catalog, same convention as security_events.event_type.
--
-- backup_runs gives backupDatabase.js/backupStorage.js's CLI-only success
-- reports a place to land, so "last successful backup" is queryable from the
-- running API instead of only inferable from local disk or external cron
-- logs (SEC-21.1/21.2/21.3's tracked gap).
--
-- Safe to run multiple times.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS system_incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  source TEXT NOT NULL CHECK (source IN ('image_provider')),
  severity TEXT NOT NULL DEFAULT 'error' CHECK (severity IN ('warning', 'error')),

  -- Mirrors the exact fields providerErrorLog.js already computes and
  -- allowlists for its console.error line - no new sanitization logic, this
  -- persists the same safe values a second time.
  provider TEXT,
  phase TEXT,
  kind TEXT,
  message TEXT,
  status_code INTEGER,
  request_id TEXT,
  user_id UUID,
  endpoint TEXT,
  detail JSONB,

  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_system_incidents_created_at
  ON system_incidents (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_system_incidents_source_created
  ON system_incidents (source, created_at DESC);

ALTER TABLE system_incidents ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS backup_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  kind TEXT NOT NULL CHECK (kind IN ('database', 'storage')),
  status TEXT NOT NULL CHECK (status IN ('success', 'failed')),

  bytes BIGINT,
  object_count INTEGER,
  duration_ms INTEGER,
  -- Manifest fragments (sha256, pgDumpVersion, bucket names, failure counts)
  -- - never credentials; these scripts never had any to begin with.
  detail JSONB,

  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_backup_runs_kind_created
  ON backup_runs (kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_backup_runs_created_at
  ON backup_runs (created_at DESC);

ALTER TABLE backup_runs ENABLE ROW LEVEL SECURITY;
