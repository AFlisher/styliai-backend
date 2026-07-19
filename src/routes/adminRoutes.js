const express = require("express");
const rateLimit = require("express-rate-limit");
const adminController = require("../controllers/adminController");
const adminStatsController = require("../controllers/adminStatsController");
const stabilityController = require("../controllers/stabilityController");
const adminAuthMiddleware = require("../middleware/adminAuthMiddleware");

const router = express.Router();

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

router.post("/login", limiter, adminController.login);
router.get("/stats", adminAuthMiddleware, adminStatsController.getStats);
router.get("/stats/countries", adminAuthMiddleware, adminStatsController.getUsersByCountry);
router.get("/users/search", adminAuthMiddleware, adminController.searchUserByEmail);
router.post("/users/:id/adjust-balance", adminAuthMiddleware, adminController.adjustUserBalance);

// Admin-only Stability AI testing tool (Style Manager's "Test Prompt" modal).
// No wallet charge, no creation-history write - see stabilityController for why.
router.post("/ai/generate-preview", adminAuthMiddleware, stabilityController.adminPreviewGenerate);

module.exports = router;