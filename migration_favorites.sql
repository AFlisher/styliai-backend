-- Migration: per-user favorites, so likes survive reinstall/device change and
-- sync across devices. Safe to run multiple times.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS favorites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  style_id UUID NOT NULL REFERENCES styles(id) ON DELETE CASCADE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT favorites_user_style_unique UNIQUE (user_id, style_id)
);

CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites (user_id);
