-- Migration: per-style source image count (multi-image styles).
--
-- min_images/max_images tell the mobile app how many source photos to
-- collect for a style and let the server enforce the same bounds on
-- /api/generate. Defaults of 1/1 mean every existing style keeps its
-- current single-image behavior without modification.
--
-- Idempotent: safe to run multiple times.

ALTER TABLE styles ADD COLUMN IF NOT EXISTS min_images INTEGER NOT NULL DEFAULT 1;
ALTER TABLE styles ADD COLUMN IF NOT EXISTS max_images INTEGER NOT NULL DEFAULT 1;
