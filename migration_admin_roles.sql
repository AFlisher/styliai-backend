-- Migration: granular admin roles (SEC-15.4).
--
-- The admins table had no role column, so authorization was a single boolean:
-- adminAuthMiddleware checked `role === 'admin'` and every route inherited that
-- one answer. Every admin could adjust balances, rewrite pricing, edit prompts
-- and delete the catalog regardless of what their job was. There was no value
-- any admin row could hold that granted less than everything.
--
-- Tiers (see src/config/adminRoutePolicy.js for the route mapping):
--   viewer     - aggregate reads only
--   editor     - catalog/product authoring
--   superadmin - money, pricing, user PII lookup
--
-- Safe to run multiple times.

ALTER TABLE admins
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'viewer';

-- Allow-list, not a deny-list: an unrecognised value must be impossible to
-- store, since the guard treats anything it does not recognise as denied.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'admins_role_check'
  ) THEN
    ALTER TABLE admins
      ADD CONSTRAINT admins_role_check
      CHECK (role IN ('viewer', 'editor', 'superadmin'));
  END IF;
END $$;

-- CRITICAL: backfill the existing admins BEFORE any code enforces the column.
--
-- The column default is 'viewer' so that a newly provisioned admin starts with
-- least privilege. Applied to the rows that already exist, that default would
-- instantly demote the live operators and lock them out of every write, with no
-- self-service way back (there is no admin password-reset or role-management
-- endpoint anywhere in this codebase).
--
-- Both current admins are the system owners and keep exactly the authority they
-- had before this migration, so the deploy is a no-op for them. Demotion, if
-- wanted, is a deliberate later UPDATE - not a side effect of adding a column.
--
-- Scoped to `role = 'viewer'` so re-running never overwrites a role that has
-- since been set on purpose.
UPDATE admins
   SET role = 'superadmin'
 WHERE email IN ('flisher@admin.com', 'mahmoud@admin.com')
   AND role = 'viewer';
