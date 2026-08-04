const favoritesModel = require("../models/favoritesModel");
const { isUuid } = require("../middleware/validateRequest");

async function getFavorites(req, res) {
  try {
    const userId = req.user.id;
    const styleIds = await favoritesModel.getFavoriteStyleIds(userId);
    res.json({ styleIds });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to load favorites." });
  }
}

async function addFavorite(req, res) {
  try {
    const userId = req.user.id;
    const { styleId } = req.body;

    if (!styleId) {
      return res.status(400).json({ message: "styleId is required." });
    }

    // SEC-9.1: shape-check before the INSERT. Without this a non-UUID styleId
    // reached Postgres and came back as 22P02, which this handler's catch does
    // not recognise (it only maps 23503), so it answered 500 for what is
    // plainly a malformed request. 400 rather than the 404 used for 23503
    // below: a value that cannot be a UUID is a bad parameter, whereas a
    // well-formed id that violates the foreign key genuinely is a missing
    // style, and collapsing the two would hide malformed-input bugs in clients.
    if (!isUuid(styleId)) {
      return res.status(400).json({ message: "styleId must be a valid UUID." });
    }

    await favoritesModel.addFavorite(userId, styleId);
    res.status(201).json({ styleId });
  } catch (err) {
    console.error(err);

    if (err.code === "23503") {
      return res.status(404).json({ message: "Style not found." });
    }

    res.status(500).json({ message: "Failed to add favorite." });
  }
}

async function removeFavorite(req, res) {
  try {
    const userId = req.user.id;
    const { styleId } = req.params;

    await favoritesModel.removeFavorite(userId, styleId);
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to remove favorite." });
  }
}

module.exports = {
  getFavorites,
  addFavorite,
  removeFavorite,
};
