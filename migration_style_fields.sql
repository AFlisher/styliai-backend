-- Migration: dynamic input fields for the Prompt Template Engine.
--
-- A style's prompt may contain {{placeholder}} tokens; each token is backed by
-- one row here describing how the mobile app should collect that value and how
-- the server should validate it. Storing fields in their own table (rather than
-- as nullable columns on `styles`) means:
--   * unlimited fields per style,
--   * new field TYPES need no schema change (type is TEXT, config is JSONB),
--   * styles with zero rows here behave exactly as before (backward compatible).
--
-- Idempotent: safe to run multiple times.

CREATE TABLE IF NOT EXISTS style_fields (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  style_id     UUID NOT NULL REFERENCES styles(id) ON DELETE CASCADE,
  field_key    TEXT NOT NULL,                 -- placeholder key, e.g. "team"
  label        TEXT NOT NULL,                 -- display label in the form
  type         TEXT NOT NULL DEFAULT 'text',  -- text|textarea|number|dropdown|checkbox|color|date|...
  required     BOOLEAN NOT NULL DEFAULT false,
  placeholder  TEXT,                          -- input hint / example
  options      JSONB,                         -- dropdown options: [{value,label}]
  config       JSONB NOT NULL DEFAULT '{}'::jsonb, -- extensible: min,max,maxLength,default,trueText,...
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- One field per key per style; also lets the app treat field_key as stable.
  CONSTRAINT style_fields_style_key_unique UNIQUE (style_id, field_key)
);

CREATE INDEX IF NOT EXISTS idx_style_fields_style_id ON style_fields(style_id);
