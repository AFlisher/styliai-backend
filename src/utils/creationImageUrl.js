"use strict";

/**
 * SEC-8.1B-2 (step 3) — the stable, client-facing address of a creation's
 * image.
 *
 * The client is handed this instead of a storage URL. It is stable in the way
 * that matters: it does not change when the object moves, when the bucket
 * becomes private, or when a signature is minted, so a client may cache it,
 * persist it and re-render it indefinitely. Everything expiring lives behind
 * it, in the redirect target, and never reaches the client's disk.
 *
 * The stored `image_url`/`thumbnail_url` columns are deliberately NOT changed
 * to this form. They stay absolute storage URLs, because SEC-8.1A's erasure
 * and SEC-8.4's reconciler both resolve them against storage by matching the
 * trailing `/<bucket>/<path>` - a row holding an API route would reference no
 * object at all, and the reconciler would then treat the real object as an
 * orphan. Storage identity stays in the database; delivery identity is
 * computed per response.
 */

const VARIANTS = Object.freeze({ image: "image", thumbnail: "thumbnail" });

/**
 * The origin to build absolute URLs on.
 *
 * `BACKEND_URL` is preferred because it is the address clients actually reach
 * us on. The request-derived fallback keeps this working in any environment
 * that has not set it (local development, tests) - `trust proxy` is configured
 * in app.js, so `req.protocol`/`host` reflect the external request rather than
 * the internal hop.
 */
function backendOrigin(req) {
  const configured = (process.env.BACKEND_URL || "").trim();
  if (configured) return configured.replace(/\/+$/, "");
  if (req && typeof req.get === "function") {
    return `${req.protocol}://${req.get("host")}`;
  }
  return "";
}

/**
 * `<origin>/api/creations/<id>/image` (or `/thumbnail`).
 */
function creationImageUrl(req, creationId, variant = VARIANTS.image) {
  return `${backendOrigin(req)}/api/creations/${encodeURIComponent(creationId)}/${variant}`;
}

/**
 * Rewrites one creation row's storage URLs into stable delivery URLs.
 *
 * A null thumbnail stays null rather than becoming a URL that would 404: the
 * client treats null as "fall back to the original", and inventing an address
 * for an object that was never created would turn a graceful fallback into a
 * broken image. Rows whose image never made it to storage (a legacy local-only
 * path migrated in by the client) keep whatever they hold - there is nothing
 * for this endpoint to serve, and the client already renders those by scheme.
 */
function withDeliveryUrls(req, creation) {
  if (!creation) return creation;

  // Fail safe rather than fail broken. With no resolvable origin the only
  // thing this could emit is a relative path, and the client dispatches on
  // scheme - it would treat `/api/creations/...` as a bundled asset key and
  // render nothing. Handing back the storage URL instead is exactly the
  // pre-migration behaviour, which still works while the bucket is public.
  // In a real request `req.get` always exists, so this is reachable only from
  // a caller that passes no request at all.
  if (!backendOrigin(req)) return creation;

  return {
    ...creation,
    imageUrl: creation.imageUrl ? creationImageUrl(req, creation.id, VARIANTS.image) : creation.imageUrl,
    thumbnailUrl: creation.thumbnailUrl
      ? creationImageUrl(req, creation.id, VARIANTS.thumbnail)
      : creation.thumbnailUrl,
  };
}

module.exports = { creationImageUrl, withDeliveryUrls, backendOrigin, VARIANTS };
