-- Migration: partial index to support GET /api/styles?trending=true
-- (the Home screen's dynamic Trending section: every enabled style with
-- is_trending = true, regardless of category). Safe to run multiple times.

CREATE INDEX IF NOT EXISTS idx_styles_trending_enabled
  ON styles (sort_order, created_at)
  WHERE is_trending = true AND is_enabled = true;
