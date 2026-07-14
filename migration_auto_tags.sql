-- Migration: tracks whether a style's tags were last set by the automatic
-- tagging pipeline (autoTagService) or manually curated by an admin, so the
-- pipeline knows never to silently overwrite a manual curation on a later,
-- unrelated edit (e.g. fixing a typo in the prompt).
-- Defaults to true so every pre-existing style is treated as "auto" until an
-- admin actually edits its tags, or backfillTags.js explicitly processes it.
-- Safe to run multiple times.

ALTER TABLE styles
  ADD COLUMN IF NOT EXISTS tags_auto_assigned BOOLEAN NOT NULL DEFAULT true;
