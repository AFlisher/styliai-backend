const express = require("express");
const router = express.Router();

const stabilityController = require("../controllers/stabilityController");
const authMiddleware = require("../middleware/authMiddleware");

/**
 * Route definitions for Stability AI text-to-image generation.
 * Fully separate from generateRoutes.js (style-transfer) and tagRoutes.js
 * (auto-tagging) - shares no service or controller with either.
 *
 * POST /api/ai/generate
 * Body (application/json): { prompt, negativePrompt?, aspectRatio?, style? }
 */
router.post("/generate", authMiddleware, stabilityController.generateImage);

module.exports = router;
