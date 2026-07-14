const express = require("express");
const router = express.Router();

const styleController = require("../controllers/styleController");
const recommendationController = require("../controllers/recommendationController");
const adminAuthMiddleware = require("../middleware/adminAuthMiddleware");
const { optionalAdminAuth } = require("../middleware/adminAuthMiddleware");
const optionalAuthMiddleware = require("../middleware/optionalAuthMiddleware");

// Both middlewares are additive and non-rejecting, verifying different
// secrets (admin token vs. a regular mobile user's Supabase token) - an
// anonymous caller is unaffected, a logged-in mobile user becomes
// identifiable via req.user for ?recommended=true.
router.get("/", optionalAdminAuth, optionalAuthMiddleware, styleController.getStyles);
router.get("/:id/similar", recommendationController.getSimilarStyles);
router.post("/", adminAuthMiddleware, styleController.createStyle);
router.put("/reorder", adminAuthMiddleware, styleController.reorderStyles);
router.put("/:id", adminAuthMiddleware, styleController.updateStyle);
router.delete("/:id", adminAuthMiddleware, styleController.deleteStyle);

module.exports = router;