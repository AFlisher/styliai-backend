const express = require("express");
const adminController = require("../controllers/adminController");
const adminStatsController = require("../controllers/adminStatsController");
const healthController = require("../controllers/healthController");
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
// Phase 5. Deliberately NOT behind adminActionLimiter: that budget is sized
// for human-paced mutations, and this endpoint exists to be polled by a
// monitoring scraper. Rate-limiting it would make it fail exactly when it is
// doing its job. It reads process-local counters, touches no database and no
// storage, and is still behind admin auth and the viewer role.
router.get("/metrics", adminAuthMiddleware, requireAdminRoleFor("GET /api/admin/metrics"), healthController.metricsSnapshot);
router.get("/stats/countries", adminActionLimiter, adminAuthMiddleware, requireAdminRoleFor("GET /api/admin/stats/countries"), adminStatsController.getUsersByCountry);
router.get("/analytics/generation/overview", adminActionLimiter, adminAuthMiddleware, requireAdminRoleFor("GET /api/admin/analytics/generation/overview"), adminGenerationAnalyticsController.getOverview);
router.get("/analytics/generation/summary", adminActionLimiter, adminAuthMiddleware, requireAdminRoleFor("GET /api/admin/analytics/generation/summary"), adminGenerationAnalyticsController.getSummary);
router.get("/users/search", adminActionLimiter, adminAuthMiddleware, requireAdminRoleFor("GET /api/admin/users/search"), adminController.searchUserByEmail);
router.post("/users/:id/adjust-balance", adminActionLimiter, adminAuthMiddleware, requireAdminRoleFor("POST /api/admin/users/:id/adjust-balance"), adminController.adjustUserBalance);

// Admin-only Stability AI testing tool (Style Manager's "Test Prompt" modal).
// No wallet charge, no creation-history write - see stabilityController for why.
//
// SEC-15.8: adminAuthMiddleware runs BEFORE the limiter here, unlike every
// other route in this file. That ordering is required, not stylistic - the
// limiter is keyed by req.admin.id, which does not exist until authentication
// has run. Same pattern as walletRoutes, where router.use(authMiddleware)
// precedes the user-id-keyed rewardClaimLimiter.
//
// The consequence is deliberate: an unauthenticated flood no longer consumes
// this limiter, because adminAuthMiddleware rejects it first and nothing
// billable is reached. The role guard sits after the limiter so an
// under-privileged admin spending their own budget cannot exhaust anyone
// else's.
router.post("/ai/generate-preview", adminAuthMiddleware, adminGenerationPreviewLimiter, requireAdminRoleFor("POST /api/admin/ai/generate-preview"), stabilityController.adminPreviewGenerate);

module.exports = router;
