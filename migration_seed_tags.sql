-- Migration: seeds the initial Tag taxonomy for RecommendationService
-- similarity scoring. Derived directly from the current style catalog's
-- actual names/prompts (Cyberpunk mercenary, Digital rendering, Viking,
-- Sphinx, black and white portrait, Player card of Barcelona, Caricature
-- Trend, TMNT pizza/Zootopia Selfie, HIP HOP, "For mom", HAPPY BIRTH DAY,
-- etc.) rather than invented buzzwords, so every tag maps to something
-- real in the catalog rather than sitting empty. Curators can add more
-- via the Admin Dashboard's Manage Tags modal as the catalog grows.
-- Safe to run multiple times (ON CONFLICT (slug) DO NOTHING - existing
-- tag rows, including any renames an admin has already made, are left
-- untouched).

INSERT INTO tags (name, slug) VALUES
  ('Cyberpunk', 'cyberpunk'),
  ('Sci-Fi', 'sci-fi'),
  ('Fantasy', 'fantasy'),
  ('Mythology', 'mythology'),
  ('Cinematic', 'cinematic'),
  ('Portrait', 'portrait'),
  ('Black & White', 'black-white'),
  ('Urban', 'urban'),
  ('Neon', 'neon'),
  ('Editorial', 'editorial'),
  ('Digital Art', 'digital-art'),
  ('Caricature', 'caricature'),
  ('Pop Culture', 'pop-culture'),
  ('Sports', 'sports'),
  ('Trading Card', 'trading-card'),
  ('Greeting Card', 'greeting-card'),
  ('Celebration', 'celebration'),
  ('Music', 'music'),
  ('Surreal', 'surreal'),
  ('Casual', 'casual'),
  ('Historical', 'historical'),
  ('Photorealistic', 'photorealistic')
ON CONFLICT (slug) DO NOTHING;
