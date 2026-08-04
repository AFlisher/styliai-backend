const express = require("express");
const router = express.Router();

const tagController = require("../controllers/tagController");
const adminAuthMiddleware = require("../middleware/adminAuthMiddleware");
const { requireAdminRoleFor } = require("../middleware/requireAdminRole");
const { adminActionLimiter } = require("../middleware/rateLimiters");
const { uuidParams, validateBody } = require("../middleware/validateRequest");
const { tagCreateSchema, tagUpdateSchema } = require("../validation/catalogSchemas");

// Tags are internal ranking metadata curated by the Admin Dashboard only -
// unlike /api/categories, there is no mobile-facing reason to list them, so
// every route here (including reads) requires an admin token.
router.use(adminActionLimiter);
router.use(adminAuthMiddleware);

// SEC-15.4: the router-level guard above establishes "is an admin"; these add
// the per-route tier. The read gets its own entry because, unlike the other
// catalog reads, this whole router is admin-only - there is no public variant.
router.get("/", requireAdminRoleFor("GET /api/tags"), tagController.getTags);
router.post("/", requireAdminRoleFor("POST /api/tags"), validateBody(tagCreateSchema), tagController.createTag);
router.put("/:id", requireAdminRoleFor("PUT /api/tags/:id"), uuidParams("id"), validateBody(tagUpdateSchema), tagController.updateTag);
router.delete("/:id", requireAdminRoleFor("DELETE /api/tags/:id"), uuidParams("id"), tagController.deleteTag);

module.exports = router;
