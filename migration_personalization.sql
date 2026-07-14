-- Migration: persist the Flutter Privacy screen's "Personalization" toggle
-- so GET /api/styles?recommended=true and the "You may also like" engine can
-- honor it server-side instead of it being a client-only no-op. Default true
-- preserves current behavior for existing users. Safe to run multiple times.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS personalization_enabled BOOLEAN NOT NULL DEFAULT true;
