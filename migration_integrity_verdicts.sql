-- Migration: integrity_verdicts — decrypt-once ledger for Play Integrity
-- tokens (SEC-0.2).
--
-- Google's Play Integrity API deliberately degrades a token that is decrypted
-- more than once: the device recognition verdict comes back empty and the app
-- and licensing verdicts come back UNEVALUATED. That is not an edge case here.
-- SEC-0.1's client reuses the same token verbatim on its one 401 retry, so a
-- user whose session expired mid-generation would present the same token twice
-- and — without this table — get a cleared verdict on the retry and look, to
-- SEC-0.5, exactly like an attacker.
--
-- So this table exists to guarantee one decode per token, cross-instance and
-- across restarts. The claim is the INSERT: the row is created with
-- status='decoding' before Google is called, and ON CONFLICT DO NOTHING means
-- the process that inserted it owns the decode while everyone else waits for
-- or reads its result. An in-process promise cache sits in front of this for
-- same-process concurrency, but that is a latency optimisation — this table is
-- the authoritative boundary, and must stay so if the backend ever runs more
-- than one instance.
--
-- Safe to run multiple times.

CREATE TABLE IF NOT EXISTS integrity_verdicts (
  -- SHA-256 of the integrity token, hex. The raw token is NEVER stored: it is
  -- a credential-shaped bearer artifact, and SEC-16.1 already established that
  -- this codebase has leaked token material into logs once. The digest is
  -- enough to deduplicate and enough to correlate, and worthless if exfiltrated.
  token_sha256 TEXT PRIMARY KEY,

  -- 'decoding' while a decode is in flight, 'done' once a verdict (or a
  -- terminal failure) has been recorded. A row that is still 'decoding' past
  -- the decode timeout is a crashed claim and may be re-claimed; see
  -- integrityVerdictModel.claim().
  status TEXT NOT NULL CHECK (status IN ('decoding', 'done')),

  -- Google's decoded payload, minus nothing — but see the retention note
  -- below. Null while status='decoding', and nulled again when the verdict
  -- cache lifetime expires while the replay ledger row lives on.
  verdict JSONB,

  -- The taxonomy code this token resolved to (INTEGRITY_OK,
  -- INTEGRITY_REQUEST_MISMATCH, ...). Kept even after `verdict` is nulled, so
  -- the replay ledger can still say what happened without retaining device
  -- attestation data.
  outcome TEXT,

  -- Recomputed server-side from the request, never taken from the client.
  -- Retained so a token re-presented later can be told apart from a legitimate
  -- 401 retry: same hash inside the reuse window is a retry, anything else is
  -- a replay.
  request_hash TEXT,
  endpoint TEXT,
  user_id UUID,

  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decoded_at TIMESTAMPTZ
);

-- Eviction sweeps and stale-claim recovery both scan by time.
CREATE INDEX IF NOT EXISTS idx_integrity_verdicts_claimed_at
  ON integrity_verdicts (claimed_at);

-- Verdict payloads are device and Play-account attestation data. They are kept
-- only long enough to serve a legitimate retry; the row itself outlives them
-- purely as a replay ledger. Both windows are configurable
-- (PLAY_INTEGRITY_VERDICT_TTL_MS, PLAY_INTEGRITY_LEDGER_TTL_MS) and are swept
-- by integrityVerdictModel.evict().
COMMENT ON COLUMN integrity_verdicts.verdict IS
  'Decoded Play Integrity payload. Nulled once the verdict cache lifetime expires; the row survives as a replay ledger entry.';

-- The backend connects as the table owner and bypasses RLS, so this is not
-- about the API's own access. It stops Supabase's auto-generated REST API from
-- exposing the table to the anon key: enabled with zero policies means
-- deny-all for every PostgREST caller. Same posture as admin_audit_log and
-- admin_mfa_recovery_codes.
ALTER TABLE integrity_verdicts ENABLE ROW LEVEL SECURITY;
