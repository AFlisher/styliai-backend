-- Migration: store email-verification tokens hashed (SHA-256 hex), matching
-- the existing reset_token_hash handling, so a DB/backup leak can't be used
-- to verify arbitrary accounts (security audit finding #6).
-- Renames users.verification_token -> users.verification_token_hash and
-- hashes any pending plaintext tokens in place, so links already sent by
-- email keep working. Safe to run multiple times.

DO $$
BEGIN
  IF EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'users'
         AND column_name = 'verification_token'
     )
     AND NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'users'
         AND column_name = 'verification_token_hash'
     ) THEN
    ALTER TABLE public.users RENAME COLUMN verification_token TO verification_token_hash;

    -- Hash pending plaintext tokens (64-char hex values are already hashes;
    -- freshly-renamed plaintext tokens are UUIDs, 36 chars with dashes).
    UPDATE public.users
    SET verification_token_hash = encode(sha256(convert_to(verification_token_hash, 'UTF8')), 'hex')
    WHERE verification_token_hash IS NOT NULL
      AND verification_token_hash !~ '^[0-9a-f]{64}$';
  END IF;
END
$$;
