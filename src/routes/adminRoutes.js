const express = require("express");
const adminController = require("../controllers/adminController");
const adminStatsController = require("../controllers/adminStatsController");
const healthController = require("../controllers/healthController");
const adminGenerationAnalyticsController = require("../controllers/adminGenerationAnalyticsController");
const stabilityController = require("../controllers/stabilityController");
const adminAuthMiddleware = require("../middleware/adminAuthMiddleware");
const { requireAdminRoleFor } = require("../middleware/requireAdminRole");
const abuseController = require("../controllers/abuseController");
const operationsController = require("../controllers/operationsController");
const systemHealthController = require("../controllers/systemHealthController");
const { adminLoginLimiter, adminActionLimiter, adminGenerationPreviewLimiter } = require("../middleware/rateLimiters");
const { uuidParams } = require("../middleware/validateRequest");

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
// User Management & Moderation module: browse/filter (list) and the drawer's
// single detail fetch. Same superadmin tier as searchUserByEmail - both
// surface user PII, just for many rows instead of exactly one.
router.get("/users", adminActionLimiter, adminAuthMiddleware, requireAdminRoleFor("GET /api/admin/users"), adminController.listUsers);
router.get("/users/:id", adminActionLimiter, adminAuthMiddleware, requireAdminRoleFor("GET /api/admin/users/:id"), uuidParams("id"), adminController.getUserDetail);
router.post("/users/:id/adjust-balance", adminActionLimiter, adminAuthMiddleware, requireAdminRoleFor("POST /api/admin/users/:id/adjust-balance"), adminController.adjustUserBalance);
// SEC-18.2 (Phase 6): account suspension. superadmin tier - it acts on a named
// user and ends their sessions, which sits with balance adjustment and PII
// lookup rather than with catalog authoring.
router.post("/users/:id/suspend", adminActionLimiter, adminAuthMiddleware, requireAdminRoleFor("POST /api/admin/users/:id/suspend"), adminController.suspendUser);
router.post("/users/:id/reinstate", adminActionLimiter, adminAuthMiddleware, requireAdminRoleFor("POST /api/admin/users/:id/reinstate"), adminController.reinstateUser);
// Account deletion (soft: see adminController.deleteUser / the migration for
// why this isn't a real row DELETE). Same tier and shape as suspend/reinstate.
router.post("/users/:id/delete", adminActionLimiter, adminAuthMiddleware, requireAdminRoleFor("POST /api/admin/users/:id/delete"), uuidParams("id"), adminController.deleteUser);

// SEC-18.1 (Phase 8): the abuse review workflow.
//
// Read-and-review only. Enforcement stays on the two Phase 6 endpoints above,
// so there is exactly ONE way to suspend an account whether a human or a
// detector decided it - a second path would be a second definition of what
// "suspended" means, only one of which authMiddleware was written against.
//
// Tiers live in config/adminRoutePolicy.js, not here: the read endpoints are
// available to any admin (looking at a review queue is what the queue is for),
// while running a sweep and recording a verdict are superadmin, because both
// write state that later threshold decisions get argued from.
router.get("/abuse/findings", adminActionLimiter, adminAuthMiddleware, requireAdminRoleFor("GET /api/admin/abuse/findings"), abuseController.listFindings);
router.get("/abuse/risk", adminActionLimiter, adminAuthMiddleware, requireAdminRoleFor("GET /api/admin/abuse/risk"), abuseController.topRisk);
router.get("/abuse/users/:id/sessions", adminActionLimiter, adminAuthMiddleware, requireAdminRoleFor("GET /api/admin/abuse/users/:id/sessions"), uuidParams("id"), abuseController.userSessions);
router.post("/abuse/findings/:id/review", adminActionLimiter, adminAuthMiddleware, requireAdminRoleFor("POST /api/admin/abuse/findings/:id/review"), uuidParams("id"), abuseController.reviewFinding);
router.post("/abuse/sweep", adminActionLimiter, adminAuthMiddleware, requireAdminRoleFor("POST /api/admin/abuse/sweep"), abuseController.runSweepNow);

// Operations Center: read-only views over admin_audit_log, security_events
// and the purchase/ad-reward verification ledgers. Superadmin tier - see
// operationsController.js and adminRoutePolicy.js for why (raw IPs, admin
// emails, cross-account history, a broader exposure than abuse/findings).
router.get("/audit-log", adminActionLimiter, adminAuthMiddleware, requireAdminRoleFor("GET /api/admin/audit-log"), operationsController.listAuditLog);
router.get("/security-events", adminActionLimiter, adminAuthMiddleware, requireAdminRoleFor("GET /api/admin/security-events"), operationsController.listSecurityEvents);
router.get("/purchases/verification-history", adminActionLimiter, adminAuthMiddleware, requireAdminRoleFor("GET /api/admin/purchases/verification-history"), operationsController.listPurchaseVerifications);

// System Health module: a rich, authenticated diagnostic view (backend/db/
// storage/email/image-provider/queue/scheduled-jobs/env/version/migrations/
// backups) plus its incident history. Viewer tier, same as /api/admin/stats
// and /api/admin/metrics - aggregate reads, no PII, no writes, no spend.
router.get("/system-health", adminActionLimiter, adminAuthMiddleware, requireAdminRoleFor("GET /api/admin/system-health"), systemHealthController.getSystemHealth);
router.get("/system-health/incidents", adminActionLimiter, adminAuthMiddleware, requireAdminRoleFor("GET /api/admin/system-health/incidents"), systemHealthController.listIncidents);

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
