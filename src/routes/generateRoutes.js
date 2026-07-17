const express = require("express");
const router = express.Router();

const upload = require("../middleware/upload");
const generateController = require("../controllers/generateController");
const authMiddleware = require("../middleware/authMiddleware");

/**
 * Route definition for AI Generation.
 * Accepts multipart/form-data containing:
 * - file: 1..5 user source photos under the same field name. How many a
 *   style actually allows is enforced per-style (min_images/max_images) in
 *   the controller; single-image clients keep sending one part unchanged.
 * - styleId: The UUID of the style preset to print.
 */
router.post(
  "/",
  authMiddleware,
  upload.array("file", 5),
  generateController.generateImage
);

module.exports = router;
