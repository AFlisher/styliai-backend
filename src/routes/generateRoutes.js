const express = require("express");
const router = express.Router();

const upload = require("../middleware/upload");
const generateController = require("../controllers/generateController");

/**
 * Route definition for AI Generation.
 * Accepts multipart/form-data containing:
 * - file: The user source portrait/photo.
 * - styleId: The UUID of the style preset to print.
 */
router.post(
  "/",
  upload.single("file"),
  generateController.generateImage
);

module.exports = router;
