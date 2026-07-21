const express = require("express");
const router = express.Router();

const favoritesController = require("../controllers/favoritesController");
const authMiddleware = require("../middleware/authMiddleware");
const { userDataLimiter } = require("../middleware/rateLimiters");

router.use(userDataLimiter);
router.use(authMiddleware);

router.get("/", favoritesController.getFavorites);
router.post("/", favoritesController.addFavorite);
router.delete("/:styleId", favoritesController.removeFavorite);

module.exports = router;
