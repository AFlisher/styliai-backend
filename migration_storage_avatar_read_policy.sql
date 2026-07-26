-- Migration: scope the avatars SELECT policy to the owning user (SEC-24.1).
--
-- FINDING (new, discovered 2026-07-26 during SEC-14.1 verification; not part
-- of the frozen Sections 0-23 baseline): the "Avatar read" policy granted
-- SELECT on storage.objects for the entire avatars bucket to role `public`,
-- i.e. to unauthenticated callers holding only the APK-bundled anon key.
-- Because avatar objects are named exactly `<user-uuid>.jpg`, an anonymous
-- POST /storage/v1/object/list/avatars returned a complete roster of real
-- user ids and the total user count.
--
-- WHY NARROW RATHER THAN DROP: removing the SELECT policy outright was tried
-- first and BROKE avatar overwrite (upsert) and delete, both HTTP 400. The
-- Storage API performs an internal read-before-write to locate the existing
-- row, and that read is RLS-gated under the caller's own role - the write
-- policies alone are not sufficient. Creating a brand-new object still
-- worked, which localised the dependency to "locating an existing row".
--
-- This policy admits exactly the one row such a lookup needs (the caller's
-- own object) and nothing else:
--   * authenticated owner  -> sees only `<their-uuid>.jpg`; overwrite/delete
--     work; listing returns just the object whose name they already know.
--   * anonymous            -> role is not `authenticated` at all, and
--     auth.uid() would be NULL so the predicate could never be true.
--     Enumeration is impossible.
--   * avatar display       -> unaffected. Public downloads go through
--     /object/public/** which bypasses RLS entirely (proven independently:
--     the `creations` bucket is public with no SELECT policy and serves
--     HTTP 200 while its list call returns []).
--
-- Verified live, in this order, all passing: upload new, overwrite existing,
-- delete existing, anonymous list (0 rows), authenticated list (own only),
-- public URL download of all existing avatars (HTTP 200).
--
-- Write policies (Avatar upload own / update own / delete own) are NOT
-- touched and the bucket remains public. Wrapped in a transaction so the
-- replacement is all-or-nothing - a failed CREATE can never leave the bucket
-- with no SELECT policy. Safe to run multiple times.

BEGIN;

DROP POLICY IF EXISTS "Avatar read" ON storage.objects;
DROP POLICY IF EXISTS "Avatar read own" ON storage.objects;

CREATE POLICY "Avatar read own" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'avatars' AND name = auth.uid() || '.jpg');

COMMIT;
