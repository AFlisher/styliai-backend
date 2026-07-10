const express = require("express");
const router = express.Router();

const upload = require("../middleware/upload");
const generateController = require("../controllers/generateController");
const authMiddleware = require("../middleware/authMiddleware");

/**
 * Route definition for AI Generation.
 * Accepts multipart/form-data containing:
 * - file: The user source portrait/photo.
 * - styleId: The UUID of the style preset to print.
 */
router.post(
  "/",
  authMiddleware,
  upload.single("file"),
  generateController.generateImage
);

module.exports = router;
