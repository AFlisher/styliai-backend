-- Migration: users wallet/credit columns.
-- balance, ads_progress, generated_images, last_login_at all exist in
-- production but were never captured in a checked-in migration.
-- Safe to run multiple times.

ALTER TABLE users ADD COLUMN IF NOT EXISTS balance INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS ads_progress SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS generated_images INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'users' AND constraint_name = 'users_balance_non_negative'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_balance_non_negative CHECK (balance >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'users' AND constraint_name = 'users_ads_progress_check'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_ads_progress_check CHECK (ads_progress >= 0 AND ads_progress <= 2);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'users' AND constraint_name = 'users_generated_images_non_negative'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_generated_images_non_negative CHECK (generated_images >= 0);
  END IF;
END $$;
