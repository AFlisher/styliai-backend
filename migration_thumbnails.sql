-- Migration: thumbnail support for styles and creations.
-- Adds a nullable thumbnail column alongside each existing image column so
-- browsing surfaces can load a small WebP preview instead of the full-size
-- original. Existing rows get NULL until the backfill script
-- (src/utils/backfillThumbnails.js) populates them; NULL is a valid,
-- permanent state for rows whose original image no longer exists.
-- Safe to run multiple times.

ALTER TABLE styles ADD COLUMN IF NOT EXISTS cover_image_thumbnail TEXT;
ALTER TABLE creations ADD COLUMN IF NOT EXISTS thumbnail_url TEXT;
