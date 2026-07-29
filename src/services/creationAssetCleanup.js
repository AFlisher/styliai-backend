/**
 * SEC-8.1A — storage erasure for deleted creations.
 *
 * Deleting a creation used to delete only its row. The stored objects stayed in
 * a public bucket, permanently and anonymously retrievable, with nothing left
 * pointing at them. Live evidence at the time of the fix: the `creations` bucket
 * held 8 objects against 2 rows.
 *
 * This module is the erasure half of SEC-8.1. It does NOT change bucket
 * visibility, introduce signed URLs, touch the upload flow, or alter any URL
 * returned to a client — all of that is Split B (Storage Privacy Architecture),
 * a separate future finding.
 *
 * ─── Why deletion is not simply "remove the row's URLs" ────────────────────
 *
 * Two properties of the current storage architecture make a naive delete
 * actively dangerous, and both are consequences of the co-mingling that Split B
 * exists to fix:
 *
 *  1. `migrateCreations` accepts a CLIENT-SUPPLIED `imageUrl`. It is the one
 *     place a creation row can be written from untrusted data (documented as
 *     accepted there, because until now the row was inert). The moment deletion
 *     started acting on that URL, it stopped being inert: a caller could migrate
 *     a row pointing at an admin style cover, delete it, and have the backend
 *     destroy a catalog asset on their behalf.
 *
 *  2. A path cannot tell you whose object it is. When this was written, admin
 *     covers and user generations shared `style-images/original/` with
 *     indistinguishable UUID filenames. SEC-8.1B-1 has since separated them —
 *     generations now go to `creations` — but the guard must not be relaxed on
 *     that basis: `migrateCreations` still accepts an arbitrary client-supplied
 *     URL, so a row can still be made to point at a catalog object regardless
 *     of where new generations are written.
 *
 * The guard is therefore referential, not positional: an object is deleted only
 * when NOTHING in the database still points at it. That predicate is checked
 * against every column in the schema that can hold a storage URL, and it is the
 * same predicate the reconciler uses — see reconcileOrphanedCreations.js. A
 * crafted row pointing at a style cover is refused because `styles.cover_image`
 * still references it; one pointing at another user's live creation is refused
 * for the same reason.
 *
 * The bucket allowlist is the second layer. `avatars` is deliberately absent:
 * avatar object names ARE user UUIDs, so a crafted URL would otherwise be a
 * trivially targeted delete of another user's avatar.
 *
 * ─── Ordering ─────────────────────────────────────────────────────────────
 *
 * The row is deleted FIRST, then the objects. The reverse ordering fails badly:
 * a storage delete that succeeds followed by a database delete that fails
 * leaves a live row rendering a dead image in the user's gallery, with no way
 * to recover the bytes. In this order a storage failure degrades to exactly the
 * pre-fix behaviour — an orphaned object — except that it is now logged and
 * swept by the reconciler. So the failure mode is the old bug, bounded, rather
 * than a new one.
 *
 * Consequently nothing here throws, and the caller must not fail the request on
 * a cleanup error. From the user's perspective the deletion succeeded: the row
 * is gone and the creation has left their gallery. Returning 500 would invite a
 * retry that 404s while the orphan survives regardless.
 */

const db = require("../config/db");
const supabase = require("../config/supabase");

/**
 * Buckets this module is permitted to delete from.
 *
 * `avatars` is excluded on purpose and must stay excluded: its object names are
 * the owner's user UUID (see the SEC-14.1/24.1 storage policies), which makes
 * an avatar the one storage object in this system an attacker can name without
 * guessing. `creations` and `style-images` use random UUID filenames.
 *
 * `style-images` stays on this list after SEC-8.1B-1 even though new
 * generations no longer land there. Two reasons: a creation row can still be
 * pointed at that bucket through `migrateCreations`, and any row predating the
 * separation would otherwise silently stop erasing its objects — a deletion
 * that quietly leaves the bytes behind is the exact bug SEC-8.1A fixed. The
 * referential guard above, not this list, is what protects catalog covers.
 */
const DELETABLE_BUCKETS = new Set(["creations", "style-images"]);

/** Marker Supabase puts in front of the bucket in a public object URL. */
const PUBLIC_URL_MARKER = "/storage/v1/object/public/";

/**
 * Splits a Supabase public object URL into its bucket and object path.
 *
 * The bucket is read FROM the URL rather than supplied by the caller, because
 * creations legitimately live in two different buckets: the Stability path
 * writes to `creations`, and the main /api/generate path writes to
 * `style-images`. Returns null for anything that is not a well-formed public
 * object URL, which is the correct outcome for a client-supplied string.
 *
 * @returns {{bucket: string, path: string}|null}
 */
function parseStorageUrl(url) {
  if (typeof url !== "string" || url.length === 0) return null;

  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }

  const idx = pathname.indexOf(PUBLIC_URL_MARKER);
  if (idx === -1) return null;

  const remainder = pathname.slice(idx + PUBLIC_URL_MARKER.length);
  const slash = remainder.indexOf("/");
  if (slash <= 0) return null;

  const bucket = decodeURIComponent(remainder.slice(0, slash));
  const path = decodeURIComponent(remainder.slice(slash + 1));
  if (!bucket || !path) return null;

  return { bucket, path };
}

/**
 * The two spellings the same object can legitimately have in a stored URL.
 *
 * SEC-8.4. This function's callers disagree about representation, and until now
 * the disagreement was silent. `parseStorageUrl` decodes before handing over a
 * path, while the reconciler passes the raw name straight out of a storage
 * listing — but both are compared against the stored URL exactly as written,
 * which is percent-encoded. For a filename needing no encoding the two are
 * identical, which is why every object in production matches today and why the
 * bug has never fired: every name is a UUID.
 *
 * The moment one is not, the mismatch fails in both dangerous directions - the
 * erasure guard stops seeing a live reference, and the reconciler reclassifies
 * a referenced object as an orphan and deletes it. Nothing enforces the UUID
 * naming assumption, so the comparison is made representation-independent
 * instead of relying on it.
 *
 * `encodeURI`, not `encodeURIComponent`: verified against what
 * `supabase.storage.getPublicUrl` actually produces - a space becomes `%20`,
 * `é` becomes `%C3%A9` and a literal `%` becomes `%25`, while `+` and `&` are
 * left alone. encodeURIComponent would additionally escape `&` and the `/`
 * separators, producing a suffix that matches nothing.
 */
function referenceSuffixes(bucket, path) {
  const decoded = `/${bucket}/${path}`;
  const encoded = `/${encodeURI(bucket)}/${encodeURI(path)}`;
  return { decoded, encoded };
}

/**
 * True if any row anywhere still points at this object.
 *
 * Every column in the schema that can hold a storage URL is checked:
 * creations.image_url, creations.thumbnail_url, styles.cover_image,
 * styles.cover_image_thumbnail, profiles.avatar_url, users.avatar_url. The
 * avatar columns are included even though `avatars` is not a deletable bucket —
 * the predicate should be true because nothing references the object, not
 * because we happened to look in the right places.
 *
 * Matching is on the trailing `/<bucket>/<path>` rather than on string equality
 * with the full URL. Exact equality would be evaded by any URL that addresses
 * the same object through a different encoding or host spelling — which is
 * precisely what a crafted `migrateCreations` payload would do. `right()` needs
 * no LIKE escaping, so a path containing `%` or `_` cannot widen the match.
 *
 * ⚠️ Must be called AFTER the creation's own row is deleted. Called before, the
 * row under deletion would reference its own object and every delete would be
 * skipped.
 */
async function isReferenced({ bucket, path }) {
  const { decoded, encoded } = referenceSuffixes(bucket, path);

  const { rows } = await db.query(
    `
    SELECT EXISTS (
      SELECT 1 FROM creations
       WHERE right(image_url, $2) = $1 OR right(image_url, $4) = $3
          OR right(thumbnail_url, $2) = $1 OR right(thumbnail_url, $4) = $3
    ) OR EXISTS (
      SELECT 1 FROM styles
       WHERE right(cover_image, $2) = $1 OR right(cover_image, $4) = $3
          OR right(cover_image_thumbnail, $2) = $1 OR right(cover_image_thumbnail, $4) = $3
    ) OR EXISTS (
      SELECT 1 FROM profiles
       WHERE right(avatar_url, $2) = $1 OR right(avatar_url, $4) = $3
    ) OR EXISTS (
      SELECT 1 FROM users
       WHERE right(avatar_url, $2) = $1 OR right(avatar_url, $4) = $3
    ) AS referenced
    `,
    [decoded, decoded.length, encoded, encoded.length]
  );

  return rows[0].referenced === true;
}

/**
 * One structured line per erasure outcome, following the conventions of
 * SEC-7.1's logModerationRejection and SEC-7.2's logGenerationBudgetEvent:
 * one JSON object, metadata only.
 *
 * Object paths ARE logged. They are random UUID filenames carrying nothing
 * about the image, they already appear in the public URL the client holds, and
 * without them a failed deletion cannot be acted on by hand. No URL, no user
 * content, and no prompt goes anywhere near this.
 */
function logErasureEvent({ event, idField, id, outcome, targets, skipped, error }) {
  const line = JSON.stringify({
    event,
    outcome, // 'deleted' | 'nothing_to_delete' | 'failed'
    [idField]: id || null,
    // [{bucket, path}] — shape only, never a URL.
    targets: targets || [],
    // Objects deliberately retained, with the reason.
    skipped: skipped || [],
    error: error || null,
  });

  if (outcome === "failed") console.error(line);
  else console.log(line);
}

/**
 * Resolves a creation's stored URLs to the set of objects that may be erased.
 *
 * Anything refused is reported rather than dropped, so a skip is visible in the
 * logs instead of looking like a successful no-op.
 *
 * @returns {Promise<{targets: Array<{bucket,path}>, skipped: Array<{reason,bucket?,path?}>}>}
 */
async function resolveDeletableTargets(urls) {
  const targets = [];
  const skipped = [];
  const seen = new Set();

  for (const url of urls) {
    if (!url) continue;

    const parsed = parseStorageUrl(url);
    if (!parsed) {
      // A client-supplied migrate URL that never pointed at our storage.
      skipped.push({ reason: "unparseable_url" });
      continue;
    }

    if (!DELETABLE_BUCKETS.has(parsed.bucket)) {
      skipped.push({ reason: "bucket_not_deletable", bucket: parsed.bucket });
      continue;
    }

    // image_url and thumbnail_url can legitimately be the same object on rows
    // that predate thumbnails; remove() would otherwise be handed a duplicate.
    const key = `${parsed.bucket}/${parsed.path}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // eslint-disable-next-line no-await-in-loop
    if (await isReferenced(parsed)) {
      skipped.push({ reason: "still_referenced", bucket: parsed.bucket, path: parsed.path });
      continue;
    }

    targets.push(parsed);
  }

  return { targets, skipped };
}

/**
 * Erases the storage objects belonging to an already-deleted row.
 *
 * Shared by every caller rather than copied per entity: the referential guard,
 * the bucket allowlist and the never-throw contract are the whole safety
 * argument, and a second implementation of them would eventually disagree with
 * this one. The disagreement would surface as deleted live images.
 *
 * Never throws — see the ordering note at the top of this file. A failure here
 * leaves an orphan, which is the pre-fix behaviour, now logged and reclaimable
 * by `npm run reconcile-creations`.
 */
async function eraseAssets({ event, idField, id, urls }) {
  try {
    const { targets, skipped } = await resolveDeletableTargets(urls || []);

    if (targets.length === 0) {
      logErasureEvent({ event, idField, id, outcome: "nothing_to_delete", targets, skipped });
      return { deleted: 0, skipped };
    }

    // Grouped per bucket because remove() is bucket-scoped, and a creation's
    // original and thumbnail can in principle sit in different buckets.
    const byBucket = new Map();
    for (const t of targets) {
      if (!byBucket.has(t.bucket)) byBucket.set(t.bucket, []);
      byBucket.get(t.bucket).push(t.path);
    }

    for (const [bucket, paths] of byBucket) {
      // eslint-disable-next-line no-await-in-loop
      const { error } = await supabase.storage.from(bucket).remove(paths);
      if (error) throw new Error(`${bucket}: ${error.message}`);
    }

    logErasureEvent({ event, idField, id, outcome: "deleted", targets, skipped });
    return { deleted: targets.length, skipped };
  } catch (err) {
    logErasureEvent({
      event,
      idField,
      id,
      outcome: "failed",
      error: typeof err?.message === "string" ? err.message : "unknown",
    });
    return { deleted: 0, skipped: [], failed: true };
  }
}

/**
 * Erases the storage objects belonging to an already-deleted creation.
 *
 * @param {object} params
 * @param {string} params.creationId  the row that was just deleted (logging only)
 * @param {Array<string|null>} params.urls  image_url and thumbnail_url from that row
 */
async function deleteCreationAssets({ creationId, urls }) {
  return eraseAssets({
    event: "creation_asset_erasure",
    idField: "creationId",
    id: creationId,
    urls,
  });
}

/**
 * Erases the cover objects belonging to an already-deleted style.
 *
 * SEC-8.4. Deleting a style used to remove only the row, leaking its cover and
 * cover thumbnail into `style-images` permanently — a bucket the reconciler
 * does not sweep by default and cannot safely sweep automatically, because a
 * mistake there costs the product catalog rather than a stale generation. So
 * the objects have to be erased at the mutation point, exactly as SEC-8.1A does
 * for creations.
 *
 * The referential guard matters more here than on the creation path, not less:
 * two styles can legitimately be pointed at the same cover URL (nothing stops
 * an admin reusing one), and this must not erase an object another style still
 * displays. That check is `isReferenced`, unchanged and shared.
 *
 * @param {object} params
 * @param {string} params.styleId  the row that was just deleted (logging only)
 * @param {Array<string|null>} params.urls  cover_image and cover_image_thumbnail
 */
async function deleteStyleAssets({ styleId, urls }) {
  return eraseAssets({
    event: "style_asset_erasure",
    idField: "styleId",
    id: styleId,
    urls,
  });
}

module.exports = {
  deleteCreationAssets,
  deleteStyleAssets,
  parseStorageUrl,
  isReferenced,
  resolveDeletableTargets,
  referenceSuffixes,
  DELETABLE_BUCKETS,
};
