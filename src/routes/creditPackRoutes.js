const express = require("express");
const router = express.Router();

const creditPackController = require("../controllers/creditPackController");
const adminAuthMiddleware = require("../middleware/adminAuthMiddleware");
const { requireAdminRoleFor } = require("../middleware/requireAdminRole");
const { publicReadLimiter, adminActionLimiter } = require("../middleware/rateLimiters");

router.get("/", publicReadLimiter, creditPackController.getCreditPacks);
// SEC-15.4: pricing is superadmin-only - see src/config/adminRoutePolicy.js.
router.post("/", adminActionLimiter, adminAuthMiddleware, requireAdminRoleFor("POST /api/credit-packs"), creditPackController.createCreditPack);
router.put("/:id", adminActionLimiter, adminAuthMiddleware, requireAdminRoleFor("PUT /api/credit-packs/:id"), creditPackController.updateCreditPack);
router.delete("/:id", adminActionLimiter, adminAuthMiddleware, requireAdminRoleFor("DELETE /api/credit-packs/:id"), creditPackController.deleteCreditPack);

module.exports = router;
