const express = require("express");
const adminController = require("../controllers/adminController");
const adminStatsController = require("../controllers/adminStatsController");
const adminGenerationAnalyticsController = require("../controllers/adminGenerationAnalyticsController");
const stabilityController = require("../controllers/stabilityController");
const adminAuthMiddleware = require("../middleware/adminAuthMiddleware");
const { adminLoginLimiter, adminActionLimiter, adminGenerationPreviewLimiter } = require("../middleware/rateLimiters");

const router = express.Router();

router.post("/login", adminLoginLimiter, adminController.login);
router.get("/stats", adminActionLimiter, adminAuthMiddleware, adminStatsController.getStats);
router.get("/stats/countries", adminActionLimiter, adminAuthMiddleware, adminStatsController.getUsersByCountry);
router.get("/analytics/generation/overview", adminActionLimiter, adminAuthMiddleware, adminGenerationAnalyticsController.getOverview);
router.get("/analytics/generation/summary", adminActionLimiter, adminAuthMiddleware, adminGenerationAnalyticsController.getSummary);
router.get("/users/search", adminActionLimiter, adminAuthMiddleware, adminController.searchUserByEmail);
router.post("/users/:id/adjust-balance", adminActionLimiter, adminAuthMiddleware, adminController.adjustUserBalance);

// Admin-only Stability AI testing tool (Style Manager's "Test Prompt" modal).
// No wallet charge, no creation-history write - see stabilityController for why.
router.post("/ai/generate-preview", adminGenerationPreviewLimiter, adminAuthMiddleware, stabilityController.adminPreviewGenerate);

module.exports = router;
