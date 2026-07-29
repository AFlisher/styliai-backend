const creationsModel = require("../models/creationsModel");
const creationAssetCleanup = require("../services/creationAssetCleanup");
const supabase = require("../config/supabase");
const { withDeliveryUrls, VARIANTS } = require("../utils/creationImageUrl");

const MAX_MIGRATE_ITEMS = 500;

/**
 * SEC-8.1B-2 — how long a redirect target stays valid.
 *
 * Short, because nothing persists it: the client only ever holds the stable
 * URL, and the signature exists for the seconds between the redirect and the
 * fetch that follows it. This is the window in which a captured target is
 * replayable, so it is sized for one image load and nothing more.
 */
const SIGNED_URL_TTL_SECONDS = 300;

async function getCreations(req, res) {
  try {
    const userId = req.user.id;
    const creations = await creationsModel.getCreationsByUser(userId);
    // SEC-8.1B-2: clients receive stable delivery URLs, never storage URLs.
    res.json(creations.map((creation) => withDeliveryUrls(req, creation)));
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to load creations." });
  }
}

/**
 * GET /api/creations/:id/image and /:id/thumbnail
 *
 * SEC-8.1B-2. Authorizes by identity, then redirects to a short-lived signed
 * URL. The bytes still come from storage's CDN rather than through this
 * process - only the decision travels through here.
 *
 * Deliberately a redirect and not a proxy: streaming every image through
 * Railway would put the app server on the path of every gallery scroll, and
 * buy nothing that the signature does not already provide.
 *
 * This works identically whether the bucket is public or private, which is the
 * property that makes the flip a configuration change rather than a deploy.
 */
function getCreationImage(variant) {
  return async function handler(req, res) {
    try {
      const userId = req.user.id;
      const { id } = req.params;

      const creation = await creationsModel.getCreationById(userId, id);
      // A creation belonging to someone else is reported exactly like one that
      // does not exist - the response must not confirm that an id is real.
      if (!creation) {
        return res.status(404).json({ message: "Creation not found." });
      }

      // The thumbnail falls back to the original, matching how the client
      // renders a row that predates thumbnails.
      const url =
        variant === VARIANTS.thumbnail
          ? creation.thumbnailUrl || creation.imageUrl
          : creation.imageUrl;

      const parsed = creationAssetCleanup.parseStorageUrl(url);
      if (!parsed) {
        // A legacy local-only path migrated in by the client, or anything else
        // that never pointed at our storage. There is nothing to serve.
        return res.status(404).json({ message: "Creation image not available." });
      }

      const { data, error } = await supabase.storage
        .from(parsed.bucket)
        .createSignedUrl(parsed.path, SIGNED_URL_TTL_SECONDS);

      if (error || !data?.signedUrl) {
        console.error(
          JSON.stringify({
            event: "creation_image_sign_failed",
            creationId: creation.id,
            bucket: parsed.bucket,
            error: error?.message || "no signed url returned",
          })
        );
        return res.status(502).json({ message: "Image is temporarily unavailable." });
      }

      // The redirect must never be cached: its target expires, and a cached
      // 302 would keep sending clients at a dead signature. The image itself
      // is cached by the client under the stable URL, which is what makes this
      // affordable.
      res.set("Cache-Control", "private, no-store");
      return res.redirect(302, data.signedUrl);
    } catch (err) {
      console.error(err);
      return res.status(500).json({ message: "Failed to load creation image." });
    }
  };
}

async function deleteCreation(req, res) {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const deleted = await creationsModel.deleteCreation(userId, id);
    if (!deleted) {
      return res.status(404).json({ message: "Creation not found." });
    }

    // SEC-8.1A — erase the stored objects too, deliberately after the row is
    // gone (see the ordering note in creationAssetCleanup). Ownership was
    // enforced by the DELETE's own user_id predicate above, and the cleanup
    // re-checks that nothing else still references the objects before removing
    // them.
    //
    // Awaited, but its outcome never reaches the response: by this point the
    // user's deletion has succeeded and the creation has left their gallery, so
    // a storage failure must not become a 500 they would retry into a 404. It
    // is logged instead, and the orphan is reclaimable via
    // `npm run reconcile-creations`. The inner catch is belt-and-braces over
    // deleteCreationAssets' own never-throw contract.
    try {
      await creationAssetCleanup.deleteCreationAssets({
        creationId: deleted.id,
        urls: [deleted.imageUrl, deleted.thumbnailUrl],
      });
    } catch (cleanupErr) {
      console.error(
        JSON.stringify({
          event: "creation_asset_erasure",
          outcome: "failed",
          creationId: deleted.id,
          error: cleanupErr?.message || "unknown",
        })
      );
    }

    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to delete creation." });
  }
}

/**
 * One-time client-driven migration path for creations that were only ever
 * recorded in the pre-existing local-JSON store on-device, before this
 * backend feature existed. Deliberately the only place a creation row can be
 * written from client-supplied data rather than server-side at generation
 * time - accepted because the impact is scoped to the caller's own history
 * only (no cross-user, credit, or financial effect), and the Flutter client
 * is expected to call this at most once per install (guarded by a local flag).
 */
async function migrateCreations(req, res) {
  try {
    const userId = req.user.id;
    const { creations } = req.body;

    if (!Array.isArray(creations)) {
      return res.status(400).json({ message: "creations array is required." });
    }

    if (creations.length > MAX_MIGRATE_ITEMS) {
      return res.status(400).json({ message: `Cannot migrate more than ${MAX_MIGRATE_ITEMS} creations at once.` });
    }

    const inserted = [];
    for (const item of creations) {
      if (!item || typeof item.styleName !== "string" || typeof item.imageUrl !== "string") {
        continue;
      }
      try {
        const row = await creationsModel.addCreation({
          userId,
          styleId: item.styleId ?? null,
          styleName: item.styleName,
          imageUrl: item.imageUrl,
          createdAt: item.createdAt ?? null,
        });
        inserted.push(row);
      } catch (itemErr) {
        // A single bad record (e.g. styleId referencing a style deleted long
        // ago) shouldn't sabotage migrating the rest of the user's history.
        console.error("[migrateCreations] Skipping one record:", itemErr.message);
      }
    }

    res.status(201).json({
      migrated: inserted.length,
      // SEC-8.1B-2: the response follows the same rule as the list - storage
      // URLs go in, delivery URLs come back.
      creations: inserted.map((creation) => withDeliveryUrls(req, creation)),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to migrate creations." });
  }
}

module.exports = {
  getCreations,
  getCreationImage,
  deleteCreation,
  migrateCreations,
  SIGNED_URL_TTL_SECONDS,
};
