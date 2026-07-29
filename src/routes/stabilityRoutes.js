const express = require("express");
const router = express.Router();

const stabilityController = require("../controllers/stabilityController");
const authMiddleware = require("../middleware/authMiddleware");
const verifyIntegrity = require("../middleware/verifyIntegrity");
const interpretIntegrity = require("../middleware/interpretIntegrity");
const concurrentGenerationLimiter = require("../middleware/concurrentGenerationLimiter");
const { generationLimiter } = require("../middleware/rateLimiters");

/**
 * Route definitions for Stability AI text-to-image generation.
 * Fully separate from generateRoutes.js (style-transfer) and tagRoutes.js
 * (auto-tagging) - shares no service or controller with either.
 *
 * POST /api/ai/generate
 * Body (application/json): { prompt, negativePrompt?, aspectRatio?, style? }
 *
 * Shares generationLimiter and concurrentGenerationLimiter with
 * generateRoutes.js - same provider-cost profile, and the concurrency map is
 * keyed by user id regardless of which of the two endpoints was called.
 */
// SEC-0.2: verifyIntegrity annotates req.integrity and never denies.
router.post("/generate", generationLimiter, authMiddleware, concurrentGenerationLimiter, verifyIntegrity, interpretIntegrity, stabilityController.generateImage);

module.exports = router;
