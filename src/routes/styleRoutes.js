const express = require("express");
const router = express.Router();

const styleController = require("../controllers/styleController");
const recommendationController = require("../controllers/recommendationController");
const adminAuthMiddleware = require("../middleware/adminAuthMiddleware");
const { optionalAdminAuth } = require("../middleware/adminAuthMiddleware");
const optionalAuthMiddleware = require("../middleware/optionalAuthMiddleware");
const { publicReadLimiter, adminActionLimiter } = require("../middleware/rateLimiters");

// Both middlewares are additive and non-rejecting, verifying different
// secrets (admin token vs. a regular mobile user's Supabase token) - an
// anonymous caller is unaffected, a logged-in mobile user becomes
// identifiable via req.user for ?recommended=true.
//
// This route also serves the mobile app's main catalog browsing (Home,
// trending, recommended, category filters) alongside the Admin Dashboard's
// style manager, so it always gets the generous publicReadLimiter rather
// than the stricter adminActionLimiter, regardless of which caller hits it.
router.get("/", publicReadLimiter, optionalAdminAuth, optionalAuthMiddleware, styleController.getStyles);
router.get("/:id/similar", publicReadLimiter, recommendationController.getSimilarStyles);
router.post("/", adminActionLimiter, adminAuthMiddleware, styleController.createStyle);
// Admin-only live prompt preview - renders the final prompt with sample
// values. Placed before "/:id" routes so "prompt-preview" isn't captured as an id.
router.post("/prompt-preview", adminActionLimiter, adminAuthMiddleware, styleController.previewPrompt);
router.put("/reorder", adminActionLimiter, adminAuthMiddleware, styleController.reorderStyles);
router.put("/:id", adminActionLimiter, adminAuthMiddleware, styleController.updateStyle);
router.patch("/:id", adminActionLimiter, adminAuthMiddleware, styleController.patchStyleFlags);
router.delete("/:id", adminActionLimiter, adminAuthMiddleware, styleController.deleteStyle);

module.exports = router;
