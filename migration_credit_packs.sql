-- Migration: credit_packs table (Roadmap Item 4.3).
-- Moves the credit-pack catalog out of prompt_app's hardcoded List<Map> into
-- a backend-managed, admin-editable table. Seeded with the same 3 packs the
-- client currently hardcodes, so behavior is unchanged on cutover.
--
-- product_id is intentionally left NULL for all seeded rows - no real
-- RevenueCat/App Store/Google Play products exist yet (Roadmap Item 4.1,
-- not started). It exists now so wiring up real billing later doesn't need
-- another migration; it must not be treated as a real product identifier
-- until Item 4.1 actually configures one.
--
-- Safe to run multiple times.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS credit_packs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  credits INTEGER NOT NULL,
  price_display TEXT NOT NULL,
  badge TEXT,
  description TEXT,
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  product_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT credit_packs_credits_positive CHECK (credits > 0),
  CONSTRAINT credit_packs_name_unique UNIQUE (name)
);

INSERT INTO credit_packs (name, credits, price_display, badge, description, sort_order)
VALUES
  ('Starter Pack', 10, '$1.99', NULL, 'Perfect for a quick experiment', 1),
  ('Pro Pack', 50, '$4.99', 'Best Value', 'Popular for creative explorers', 2),
  ('Max Pack', 100, '$8.99', 'Save 25%', 'For serious power creators', 3)
ON CONFLICT (name) DO NOTHING;
