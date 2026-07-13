const favoritesModel = require("../models/favoritesModel");

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
