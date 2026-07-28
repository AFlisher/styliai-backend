const express = require("express");
const adminController = require("../controllers/adminController");
const adminStatsController = require("../controllers/adminStatsController");
const adminGenerationAnalyticsController = require("../controllers/adminGenerationAnalyticsController");
const stabilityController = require("../controllers/stabilityController");
const adminAuthMiddleware = require("../middleware/adminAuthMiddleware");
const { requireAdminRoleFor } = require("../middleware/requireAdminRole");
const { adminLoginLimiter, adminActionLimiter, adminGenerationPreviewLimiter } = require("../middleware/rateLimiters");

const router = express.Router();

// SEC-15.4: requireAdminRoleFor looks each route's tier up in
// src/config/adminRoutePolicy.js rather than hard-coding it here, so the policy
// table stays the single source of truth for both these registrations and the
// matrix test. A route added without an entry there throws at startup.
router.post("/login", adminLoginLimiter, adminController.login);
router.get("/stats", adminActionLimiter, adminAuthMiddleware, requireAdminRoleFor("GET /api/admin/stats"), adminStatsController.getStats);
router.get("/stats/countries", adminActionLimiter, adminAuthMiddleware, requireAdminRoleFor("GET /api/admin/stats/countries"), adminStatsController.getUsersByCountry);
router.get("/analytics/generation/overview", adminActionLimiter, adminAuthMiddleware, requireAdminRoleFor("GET /api/admin/analytics/generation/overview"), adminGenerationAnalyticsController.getOverview);
router.get("/analytics/generation/summary", adminActionLimiter, adminAuthMiddleware, requireAdminRoleFor("GET /api/admin/analytics/generation/summary"), adminGenerationAnalyticsController.getSummary);
router.get("/users/search", adminActionLimiter, adminAuthMiddleware, requireAdminRoleFor("GET /api/admin/users/search"), adminController.searchUserByEmail);
router.post("/users/:id/adjust-balance", adminActionLimiter, adminAuthMiddleware, requireAdminRoleFor("POST /api/admin/users/:id/adjust-balance"), adminController.adjustUserBalance);

// Admin-only Stability AI testing tool (Style Manager's "Test Prompt" modal).
// No wallet charge, no creation-history write - see stabilityController for why.
router.post("/ai/generate-preview", adminGenerationPreviewLimiter, adminAuthMiddleware, requireAdminRoleFor("POST /api/admin/ai/generate-preview"), stabilityController.adminPreviewGenerate);

module.exports = router;
