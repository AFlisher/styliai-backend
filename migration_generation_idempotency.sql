-- Migration: generation idempotency keys (Phase 7, SEC-3.1).
--
-- Before this, the generation endpoints accepted no idempotency key. Each
-- request independently deducted credits and called the paid AI provider, with
-- no dedupe of a client retry of the SAME logical request. On a flaky network -
-- exactly when clients retry - a user whose generation actually succeeded
-- server-side but whose response was lost would be charged twice and would
-- cause two paid provider calls.
--
-- This is NOT a credit-creation exploit: a retry only ever spends, never
-- mints, so it cannot be used to gain balance. It is a financial-correctness
-- and cost-control defect, and the audit's Section 3 checklist requires
-- "Duplicate request protection / No duplicate charge" explicitly.
--
-- The AdMob SSV path already had this property via a transaction_id primary
-- key (Section 5), and this table deliberately reuses that shape: claim a
-- unique key atomically BEFORE doing the expensive, chargeable work, so the
-- database - not application logic - is what makes the claim exclusive.
--
-- Safe to run multiple times.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS generation_idempotency (
  -- (user_id, idempotency_key) is the primary key rather than a surrogate id.
  --
  -- Scoping the key to the user is a security property, not a modelling
  -- preference: a globally-unique key would let one account claim a key value
  -- that another account then could not use, and - far worse - would let a
  -- caller who guessed another user's key REPLAY that user's stored response
  -- and read their generated image URLs. Scoping makes both impossible by
  -- construction, and means clients can use any key scheme they like without
  -- colliding with anyone else.
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,

  -- Which endpoint claimed it. The same key sent to /api/generate and to
  -- /api/ai/generate is two different logical requests, and treating them as
  -- one would replay a style-transfer response to a text-to-image call.
  endpoint TEXT NOT NULL,

  -- SHA-256 over the request's meaningful inputs. Guards against key REUSE
  -- with different content: a client that recycles a key for a genuinely
  -- different generation must get an error, not a silent replay of the old
  -- image. This is the standard IETF idempotency semantic and the difference
  -- between "safe retry" and "silently wrong result".
  request_fingerprint TEXT NOT NULL,

  -- 'in_progress' is written BEFORE the wallet deduction and flipped to
  -- 'completed' only after a successful response. A row stuck in 'in_progress'
  -- therefore means a request that crashed mid-flight; it blocks concurrent
  -- duplicates (which is the point) and expires with the TTL sweep below.
  status TEXT NOT NULL DEFAULT 'in_progress'
    CHECK (status IN ('in_progress', 'completed')),

  -- The exact response body to replay. Only ever the caller's OWN generation
  -- result (delivery URLs and ids that the same user already received), so
  -- storing it discloses nothing they are not entitled to. Null until the
  -- request completes.
  response_body JSONB,
  response_status INTEGER,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,

  PRIMARY KEY (user_id, idempotency_key)
);

-- Supports the TTL sweep, which deletes by age across all users. Without it
-- the sweep is a sequential scan of the whole table - and a cleanup job that
-- gets more expensive as the table grows is the same class of defect as
-- SEC-19.1.
CREATE INDEX IF NOT EXISTS idx_generation_idempotency_created
  ON generation_idempotency (created_at);

COMMENT ON TABLE generation_idempotency IS
  'SEC-3.1: per-user idempotency claims for the generation endpoints. Rows are '
  'transient - retained only for the replay window (IDEMPOTENCY_TTL_HOURS, '
  'default 24h) and then swept. Not an audit log; wallet_transactions remains '
  'the financial record of truth.';
