const express = require("express");
const router = express.Router();

const styleController = require("../controllers/styleController");
const recommendationController = require("../controllers/recommendationController");
const adminAuthMiddleware = require("../middleware/adminAuthMiddleware");
const { optionalAdminAuth } = require("../middleware/adminAuthMiddleware");
const authMiddleware = require("../middleware/authMiddleware");
const { publicReadLimiter, adminActionLimiter } = require("../middleware/rateLimiters");

// optionalAdminAuth is additive and non-rejecting (verifies the admin
// secret; an anonymous or mobile caller is unaffected). requireUserOrAdmin
// then either bypasses (req.admin already set - the Admin Dashboard always
// sends its admin bearer token) or falls back to the strict authMiddleware,
// so a caller with neither an admin token nor a valid Supabase user JWT is
// rejected with 401 instead of being served the catalog anonymously.
//
// This route also serves the mobile app's main catalog browsing (Home,
// trending, recommended, category filters) alongside the Admin Dashboard's
// style manager, so it always gets the generous publicReadLimiter rather
// than the stricter adminActionLimiter, regardless of which caller hits it.
router.get("/", publicReadLimiter, optionalAdminAuth, authMiddleware.requireUserOrAdmin, styleController.getStyles);
router.get("/:id/similar", publicReadLimiter, authMiddleware, recommendationController.getSimilarStyles);
router.post("/", adminActionLimiter, adminAuthMiddleware, styleController.createStyle);
// Admin-only live prompt preview - renders the final prompt with sample
// values. Placed before "/:id" routes so "prompt-preview" isn't captured as an id.
router.post("/prompt-preview", adminActionLimiter, adminAuthMiddleware, styleController.previewPrompt);
router.put("/reorder", adminActionLimiter, adminAuthMiddleware, styleController.reorderStyles);
router.put("/:id", adminActionLimiter, adminAuthMiddleware, styleController.updateStyle);
router.patch("/:id", adminActionLimiter, adminAuthMiddleware, styleController.patchStyleFlags);
router.delete("/:id", adminActionLimiter, adminAuthMiddleware, styleController.deleteStyle);

module.exports = router;
