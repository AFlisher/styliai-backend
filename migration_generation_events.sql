-- Migration: analytics event log written on every SUCCESSFUL generation.
-- This is the source of truth for the admin dashboard's generation
-- analytics (overview counts, most-used styles/categories, average
-- generation time). Never stores the generated image or the uploaded
-- source image - only ids/metrics. Safe to run multiple times.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS generation_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  style_id UUID REFERENCES styles(id) ON DELETE SET NULL,
  category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
  generation_time_ms INTEGER,
  success BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Every dashboard aggregation query filters/groups by some combination of
-- these four columns (see adminGenerationAnalyticsController), so each gets
-- its own index rather than one composite covering only one query shape.
CREATE INDEX IF NOT EXISTS idx_generation_events_user_id ON generation_events (user_id);
CREATE INDEX IF NOT EXISTS idx_generation_events_style_id ON generation_events (style_id);
CREATE INDEX IF NOT EXISTS idx_generation_events_category_id ON generation_events (category_id);
CREATE INDEX IF NOT EXISTS idx_generation_events_created_at ON generation_events (created_at);
