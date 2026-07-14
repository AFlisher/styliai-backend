-- Migration: curated Tags for styles, powering style-similarity scoring in
-- RecommendationService. A closed, admin-managed vocabulary (not free text)
-- so similarity queries stay a cheap join and tags don't fragment into
-- near-duplicates ("vintage" vs "retro"). Safe to run multiple times.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tags_slug_unique UNIQUE (slug)
);

CREATE TABLE IF NOT EXISTS style_tags (
  style_id UUID NOT NULL REFERENCES styles(id) ON DELETE CASCADE,
  tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (style_id, tag_id)
);

-- Composite PK already indexes style_id -> tags; this covers the reverse
-- "which other styles share this tag" direction the recommender needs.
CREATE INDEX IF NOT EXISTS idx_style_tags_tag_id ON style_tags (tag_id);
