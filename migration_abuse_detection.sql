-- Migration: abuse detection and correlation (Phase 8).
--
-- Covers SEC-18.3 (origin correlation key), SEC-18.1 (detection findings +
-- risk scores) and SEC-18.5 (session/device signal on the Phase 6
-- refresh_tokens table).
--
-- CONTEXT FROM THE AUDIT. Section 18's own conclusion is that the missing
-- controls here matter less than they normally would, because the economics
-- are deliberately hostile to farming: no signup bonus, no referral, and free
-- credits cost two real Google-verified ad impressions each, capped at one per
-- account per day. A farmer's marginal cost is roughly their marginal benefit.
--
-- What this migration adds is therefore NOT a response to active abuse. It is
-- the ability to KNOW - the audit's phrase is "you would not know either way" -
-- and the join key that makes an investigation possible at all. Both become
-- load-bearing the day a signup bonus, referral, promo or paid purchase
-- (SEC-6.1) ships, which is a predictable date rather than a hypothetical one.
--
-- Safe to run multiple times.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- 1. SEC-18.3 - a correlation key that is not personal data.
-- ---------------------------------------------------------------------------
-- Both registration paths resolved the country from the request IP and then
-- discarded the IP, with a code comment saying so. That is good data
-- minimisation, and the audit is explicit that it is a defensible privacy
-- decision - but it has a cost it records rather than disputes: IP is the
-- primary correlation signal for multi-accounting, so two accounts created one
-- second apart from the same device on the same connection are, in the stored
-- data, indistinguishable from two unrelated users in the same country.
--
-- The audit's own recommendation is followed exactly: store HMAC(server_salt,
-- ip), not the IP. That supports "how many accounts share this origin" while
-- being irreversible without the salt, and it is NOT a reversible identifier -
-- rotating IP_HASH_SALT invalidates every stored hash, which is the intended
-- retention control.
--
-- Deliberately NOT unique and NOT a foreign key: many legitimate users share
-- an origin (carrier-grade NAT, campus wifi, a household), so this is a
-- correlation hint for a human reviewer, never an authorization input.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS signup_origin_hash TEXT;

-- Supports "how many accounts share this origin", the SEC-18.1 registration
-- velocity detector's core query. Partial, because the column is null for every
-- pre-Phase-8 account and for any request whose IP could not be resolved.
CREATE INDEX IF NOT EXISTS idx_users_signup_origin
  ON public.users (signup_origin_hash, created_at DESC)
  WHERE signup_origin_hash IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. SEC-18.5 - make the Phase 6 refresh_tokens table a session signal.
-- ---------------------------------------------------------------------------
-- Phase 6 already created one row per login with a family_id, issued_at,
-- used_at and revoked_at. That IS the sessions table the audit asked for; what
-- was missing is that nothing recorded WHERE a session came from and nothing
-- ever read the table as a concurrency signal.
--
-- Adding two columns is the whole change. No new table, because a second
-- session concept would have to be kept consistent with the first, and the
-- audit's recommendation to "sequence it after SEC-1.1 and SEC-18.2, which need
-- the same machinery" is precisely an instruction not to build a parallel one.
ALTER TABLE refresh_tokens
  ADD COLUMN IF NOT EXISTS origin_hash TEXT,
  -- Truncated and coarse (see utils/deviceLabel.js). A full User-Agent is a
  -- fingerprinting surface and, on a mobile client, mostly a constant; the
  -- coarse label is enough to tell a human "Android" from "iOS" from "web"
  -- without storing anything that narrows an individual.
  ADD COLUMN IF NOT EXISTS device_label TEXT;

-- "Which origins is this account live from right now" - the concurrent-use
-- query. Partial on live sessions only, which is the only set that question
-- applies to.
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_live
  ON refresh_tokens (user_id, issued_at DESC)
  WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- 3. SEC-18.1 - where a detection lands.
-- ---------------------------------------------------------------------------
-- One row per (user, detector, day). The audit asks for scheduled queries plus
-- a risk score surfaced in the dashboard; persisting the finding rather than
-- only logging it is what makes the dashboard view a lookup instead of a
-- re-scan, and what lets a human see that a detector fired yesterday too.
CREATE TABLE IF NOT EXISTS abuse_findings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Nullable: origin-scoped detectors (registration velocity) implicate a
  -- GROUP of accounts, not one. ON DELETE CASCADE so deleting a user does not
  -- leave findings pointing at nothing - the finding is about the account, and
  -- has no meaning once the account is gone.
  user_id UUID REFERENCES public.users(id) ON DELETE CASCADE,

  -- Which detector fired. Text rather than an enum so adding a detector is a
  -- code change, not a migration.
  detector TEXT NOT NULL,

  -- 'low' | 'medium' | 'high'. Drives whether automatic action is even
  -- considered; see services/abuse/abusePolicy.js.
  severity TEXT NOT NULL DEFAULT 'low'
    CHECK (severity IN ('low', 'medium', 'high')),

  -- The numbers that caused the finding: observed value, threshold, window.
  -- JSONB so each detector records what is meaningful to it. NEVER contains
  -- prompts, emails, IPs, or tokens - only counts, thresholds and hashes.
  -- This is what an operator reads to decide whether the detector was right.
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- The correlation key, when the finding is origin-scoped.
  origin_hash TEXT,

  -- What was actually DONE. 'flagged' is the default and the safe one; an
  -- automatic suspension records 'suspended' here, so "what did the system do
  -- to this account, and why" is one query rather than a log trawl.
  action TEXT NOT NULL DEFAULT 'flagged'
    CHECK (action IN ('flagged', 'suspended', 'none')),

  -- Admin review workflow. NULL = not yet reviewed.
  reviewed_at TIMESTAMPTZ,
  reviewed_by UUID,
  review_outcome TEXT
    CHECK (review_outcome IS NULL OR review_outcome IN ('confirmed', 'false_positive', 'ignored')),

  -- The detection window this finding covers, so re-running a detector over
  -- the same window updates rather than duplicates.
  window_start TIMESTAMPTZ NOT NULL,
  window_end   TIMESTAMPTZ NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotency for the detectors: re-running a sweep over a window that already
-- produced a finding must UPDATE it, not add a duplicate. Without this a
-- detector that runs opportunistically (which these do - there is no scheduler,
-- see SEC-20.x) would accumulate one row per invocation.
--
-- COALESCE on the nullable columns because NULL never equals NULL in a unique
-- index, so origin-scoped findings (user_id NULL) would otherwise never
-- conflict and would duplicate on every sweep.
CREATE UNIQUE INDEX IF NOT EXISTS idx_abuse_findings_dedupe
  ON abuse_findings (
    detector,
    COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(origin_hash, ''),
    window_start
  );

-- The dashboard's "what needs looking at" query.
CREATE INDEX IF NOT EXISTS idx_abuse_findings_open
  ON abuse_findings (created_at DESC)
  WHERE reviewed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_abuse_findings_user
  ON abuse_findings (user_id, created_at DESC)
  WHERE user_id IS NOT NULL;

COMMENT ON TABLE abuse_findings IS
  'SEC-18.1: one row per (detector, subject, window). Evidence is counts and '
  'thresholds only - never prompts, emails, IPs or tokens. `action` records '
  'what the system did; reinstating a user is admin_controller suspend/'
  'reinstate (Phase 6), which is the documented rollback path.';

-- ---------------------------------------------------------------------------
-- 4. SEC-18.1 - the per-account risk score.
-- ---------------------------------------------------------------------------
-- Deliberately a SEPARATE table from abuse_findings. A finding is an event
-- ("this detector fired over this window"); a score is current state ("how
-- risky does this account look right now"). Collapsing them would mean either
-- recomputing the score by aggregating history on every dashboard load - the
-- SEC-19.1 mistake - or losing the history.
CREATE TABLE IF NOT EXISTS user_risk_scores (
  user_id UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,

  -- 0-100. Not a probability and not calibrated against anything; it is a
  -- ranking aid so a human looks at the right accounts first. Documented as
  -- such in services/abuse/riskScore.js so nobody later treats it as a
  -- decision input on its own.
  score SMALLINT NOT NULL DEFAULT 0 CHECK (score >= 0 AND score <= 100),

  -- Which signals contributed, with their individual contributions. Makes the
  -- score explainable - an unexplainable score cannot be acted on, and cannot
  -- be debugged when it is wrong.
  factors JSONB NOT NULL DEFAULT '{}'::jsonb,

  computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_risk_scores_top
  ON user_risk_scores (score DESC, computed_at DESC);

COMMENT ON TABLE user_risk_scores IS
  'SEC-18.1: a ranking aid for human review, NOT a probability and NOT an '
  'authorization input. `factors` explains every contribution so a score can '
  'be argued with.';
