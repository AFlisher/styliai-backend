-- Migration: per-user creation history, so generated images survive
-- reinstall/device change. style_id uses ON DELETE SET NULL (not CASCADE) and
-- style_name is denormalized at write time - deleting or renaming a style
-- later must never delete or corrupt a user's own creation history.
-- Safe to run multiple times.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS creations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  style_id UUID REFERENCES styles(id) ON DELETE SET NULL,
  style_name VARCHAR(255) NOT NULL,
  image_url TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_creations_user_created ON creations (user_id, created_at DESC);
