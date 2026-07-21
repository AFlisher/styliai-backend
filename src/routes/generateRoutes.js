const express = require("express");
const router = express.Router();

const upload = require("../middleware/upload");
const generateController = require("../controllers/generateController");
const authMiddleware = require("../middleware/authMiddleware");
const concurrentGenerationLimiter = require("../middleware/concurrentGenerationLimiter");
const { generationLimiter } = require("../middleware/rateLimiters");

/**
 * Route definition for AI Generation.
 * Accepts multipart/form-data containing:
 * - file: 1..5 user source photos under the same field name. How many a
 *   style actually allows is enforced per-style (min_images/max_images) in
 *   the controller; single-image clients keep sending one part unchanged.
 * - styleId: The UUID of the style preset to print.
 *
 * generationLimiter bounds request rate per IP; concurrentGenerationLimiter
 * separately bounds how many of THIS user's generations can be in flight at
 * once (an IP-rate limit alone doesn't stop one account firing many parallel
 * requests that each stay under the per-minute cap). Order: cheap IP check
 * first, then auth, then the per-user in-flight check, before the multipart
 * body is even parsed.
 */
router.post(
  "/",
  generationLimiter,
  authMiddleware,
  concurrentGenerationLimiter,
  upload.array("file", 5),
  generateController.generateImage
);

module.exports = router;
