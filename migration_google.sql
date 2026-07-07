-- Migration: Add Google Sign-In columns to public.users
-- Safe to run multiple times (uses IF NOT EXISTS / IF EXISTS guards)

-- Add provider column (email | google)
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS provider VARCHAR DEFAULT 'email';

-- Add google_id column
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS google_id VARCHAR NULL;

-- Add avatar_url column (if not already present via profiles)
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS avatar_url VARCHAR(512) NULL;

-- Unique index on google_id (only for non-null values)
CREATE UNIQUE INDEX IF NOT EXISTS users_google_id_idx
  ON public.users(google_id)
  WHERE google_id IS NOT NULL;

-- Add provider column to public.profiles
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS provider VARCHAR DEFAULT 'email';

-- Sync provider data from users to profiles
UPDATE public.profiles p
SET provider = u.provider
FROM public.users u
WHERE p.id = u.id;
