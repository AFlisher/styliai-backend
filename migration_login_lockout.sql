-- Migration: per-account login lockout columns (SEC-1.3).
-- Adds failed-attempt tracking to both login surfaces: public.users
-- (POST /api/auth/login) and admins (POST /api/admin/login). The lockout
-- logic lives in authController.login / adminController.login; a NULL
-- locked_until means "not locked". Safe to run multiple times.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;

ALTER TABLE admins
  ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;
