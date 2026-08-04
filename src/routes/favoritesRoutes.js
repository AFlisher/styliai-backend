const express = require("express");
const router = express.Router();

const favoritesController = require("../controllers/favoritesController");
const authMiddleware = require("../middleware/authMiddleware");
const { userDataLimiter } = require("../middleware/rateLimiters");
const { uuidParams } = require("../middleware/validateRequest");

router.use(userDataLimiter);
router.use(authMiddleware);

router.get("/", favoritesController.getFavorites);
router.post("/", favoritesController.addFavorite);
// SEC-9.1: removeFavorite had no catch for 22P02 at all, so a malformed
// styleId was a 500. The body-supplied styleId on POST is validated in the
// controller instead, where the existing 23503 -> 404 "Style not found"
// mapping already lives and must keep its meaning.
router.delete("/:styleId", uuidParams("styleId"), favoritesController.removeFavorite);

module.exports = router;
