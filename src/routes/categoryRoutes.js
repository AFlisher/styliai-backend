const express = require("express");
const router = express.Router();

const categoryController = require("../controllers/categoryController");
const adminAuthMiddleware = require("../middleware/adminAuthMiddleware");
const { optionalAdminAuth } = require("../middleware/adminAuthMiddleware");
const authMiddleware = require("../middleware/authMiddleware");
const { publicReadLimiter, adminActionLimiter } = require("../middleware/rateLimiters");

// Categories must never be readable by an unauthenticated caller (guest
// users see only the Welcome screen, never Categories/Styles). The Admin
// Dashboard is unaffected: it always sends its admin bearer token, which
// optionalAdminAuth turns into req.admin, letting requireUserOrAdmin bypass
// the strict user-JWT check below - same pattern already used on
// GET /api/styles.
router.get("/", publicReadLimiter, optionalAdminAuth, authMiddleware.requireUserOrAdmin, categoryController.getCategories);

router.post("/", adminActionLimiter, adminAuthMiddleware, categoryController.createCategory);

router.put("/reorder", adminActionLimiter, adminAuthMiddleware, categoryController.reorderCategories);

router.put("/:id", adminActionLimiter, adminAuthMiddleware, categoryController.updateCategory);

router.delete("/:id", adminActionLimiter, adminAuthMiddleware, categoryController.deleteCategory);
module.exports = router;
