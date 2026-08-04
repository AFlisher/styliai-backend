const express = require("express");
const router = express.Router();

const upload = require("../middleware/upload");
const generateController = require("../controllers/generateController");
const authMiddleware = require("../middleware/authMiddleware");
const concurrentGenerationLimiter = require("../middleware/concurrentGenerationLimiter");
const verifyIntegrity = require("../middleware/verifyIntegrity");
const interpretIntegrity = require("../middleware/interpretIntegrity");
const enforceIntegrity = require("../middleware/enforceIntegrity");
const { generationLimiter } = require("../middleware/rateLimiters");
const { idempotency } = require("../middleware/idempotency");

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
  // SEC-0.2: after multipart parsing - the request hash covers styleId,
  // fieldValues and the file count, none of which exist before this point.
  // Annotates req.integrity and never denies; SEC-0.5 will act on it.
  verifyIntegrity,
  // SEC-0.3: interprets what SEC-0.2 verified into a normalized state.
  // Annotates req.integrityAssessment; still denies nothing.
  interpretIntegrity,
  // SEC-0.5: the first layer allowed to refuse. Endpoint ceiling and the
  // global kill switch both live in config/integrityPolicy.js.
  enforceIntegrity,
  // SEC-3.1: last middleware before the controller, which is where the wallet
  // deduction and the paid provider call happen. Everything above it can still
  // refuse the request for free; from here on it costs money, so this is the
  // point at which a duplicate has to be caught. It also runs after
  // upload.array so the fingerprint can include the source images - retrying
  // "the same request" with a different photo is a different request.
  //
  // No key header ⇒ no-op, so existing clients are unaffected.
  idempotency({ endpoint: "POST /api/generate" }),
  generateController.generateImage
);

module.exports = router;
