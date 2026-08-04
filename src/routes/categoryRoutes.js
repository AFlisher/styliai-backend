const express = require("express");
const router = express.Router();

const categoryController = require("../controllers/categoryController");
const adminAuthMiddleware = require("../middleware/adminAuthMiddleware");
const { optionalAdminAuth } = require("../middleware/adminAuthMiddleware");
const { requireAdminRoleFor } = require("../middleware/requireAdminRole");
const authMiddleware = require("../middleware/authMiddleware");
const { publicReadLimiter, adminActionLimiter } = require("../middleware/rateLimiters");
const { uuidParams, validateBody } = require("../middleware/validateRequest");
const { categoryCreateSchema, categoryUpdateSchema } = require("../validation/catalogSchemas");

// Categories must never be readable by an unauthenticated caller (guest
// users see only the Welcome screen, never Categories/Styles). The Admin
// Dashboard is unaffected: it always sends its admin bearer token, which
// optionalAdminAuth turns into req.admin, letting requireUserOrAdmin bypass
// the strict user-JWT check below - same pattern already used on
// GET /api/styles.
router.get("/", publicReadLimiter, optionalAdminAuth, authMiddleware.requireUserOrAdmin, categoryController.getCategories);

// SEC-15.4: tiers come from src/config/adminRoutePolicy.js, not from here.
router.post("/", adminActionLimiter, adminAuthMiddleware, requireAdminRoleFor("POST /api/categories"), validateBody(categoryCreateSchema), categoryController.createCategory);

router.put("/reorder", adminActionLimiter, adminAuthMiddleware, requireAdminRoleFor("PUT /api/categories/reorder"), categoryController.reorderCategories);

router.put("/:id", adminActionLimiter, adminAuthMiddleware, requireAdminRoleFor("PUT /api/categories/:id"), uuidParams("id"), validateBody(categoryUpdateSchema), categoryController.updateCategory);

router.delete("/:id", adminActionLimiter, adminAuthMiddleware, requireAdminRoleFor("DELETE /api/categories/:id"), uuidParams("id"), categoryController.deleteCategory);
module.exports = router;
