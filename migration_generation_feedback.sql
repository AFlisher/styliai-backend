-- Migration: user feedback (star rating + optional comment) captured after
-- a successful generation. generation_id references creations(id) - not a
-- separate "generation" table, since creations is already this app's
-- record of a completed generation - and uses ON DELETE SET NULL so
-- deleting a creation later never deletes the feedback that references it.
-- Never stores the generated image or the uploaded source image - only
-- ids/metrics/text feedback. Safe to run multiple times.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS generation_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  generation_id UUID REFERENCES creations(id) ON DELETE SET NULL,
  style_id UUID REFERENCES styles(id) ON DELETE SET NULL,
  category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
  rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  generation_time_ms INTEGER,
  app_version VARCHAR(32),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_generation_feedback_user_id ON generation_feedback (user_id);
CREATE INDEX IF NOT EXISTS idx_generation_feedback_style_id ON generation_feedback (style_id);
CREATE INDEX IF NOT EXISTS idx_generation_feedback_category_id ON generation_feedback (category_id);
CREATE INDEX IF NOT EXISTS idx_generation_feedback_created_at ON generation_feedback (created_at);
