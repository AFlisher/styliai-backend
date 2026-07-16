-- Migration: persist the Edit Profile screen's Bio field. Nullable so
-- existing rows are untouched; the app falls back to its default bio text
-- when unset. Safe to run multiple times.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS bio TEXT;
