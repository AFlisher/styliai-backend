const creationsModel = require("../models/creationsModel");

const MAX_MIGRATE_ITEMS = 500;

async function getCreations(req, res) {
  try {
    const userId = req.user.id;
    const creations = await creationsModel.getCreationsByUser(userId);
    res.json(creations);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to load creations." });
  }
}

async function deleteCreation(req, res) {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const deleted = await creationsModel.deleteCreation(userId, id);
    if (!deleted) {
      return res.status(404).json({ message: "Creation not found." });
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

    res.status(201).json({ migrated: inserted.length, creations: inserted });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to migrate creations." });
  }
}

module.exports = {
  getCreations,
  deleteCreation,
  migrateCreations,
};
