-- Migration: avatars bucket content limits (SEC-14.1).
--
-- Avatars are uploaded by the Flutter client DIRECTLY to Supabase Storage
-- (ProfileService.uploadAvatar), bypassing the Node backend - so the
-- magic-byte/MIME/size validation in src/middleware/upload.js never runs on
-- this path. Owner-scoped RLS policies on storage.objects already restrict
-- WHO may write WHERE (name must equal auth.uid() || '.jpg'), but the bucket
-- declared no constraint on WHAT: any Content-Type and any size were
-- accepted into a public bucket, allowing arbitrary content (e.g. text/html)
-- to be served from the project's storage domain.
--
-- This sets the two missing bucket-level limits:
--   * allowed_mime_types = {image/jpeg} - the client has always declared
--     contentType 'image/jpeg' (unchanged since the first commit of that
--     code), and every existing object in the bucket is image/jpeg, so this
--     rejects nothing a real client sends.
--   * file_size_limit = 10 MiB - matches the creations/style-images buckets.
--     Deliberately NOT tighter: the client re-encodes at JPEG quality 85
--     WITHOUT resizing, so a high-resolution phone photo can legitimately be
--     several MB. Largest object in the bucket today is ~223 KB.
--
-- Note this validates the DECLARED Content-Type, not magic bytes. Closing
-- that gap requires routing avatar uploads through the backend and is
-- tracked separately; this migration is the zero-code, zero-regression half.
--
-- Storage RLS policies are NOT touched here. Safe to run multiple times.

UPDATE storage.buckets
SET allowed_mime_types = ARRAY['image/jpeg'],
    file_size_limit = 10485760  -- 10 MiB
WHERE id = 'avatars';
