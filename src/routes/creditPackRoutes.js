const express = require("express");
const router = express.Router();

const creditPackController = require("../controllers/creditPackController");
const adminAuthMiddleware = require("../middleware/adminAuthMiddleware");
const { publicReadLimiter, adminActionLimiter } = require("../middleware/rateLimiters");

router.get("/", publicReadLimiter, creditPackController.getCreditPacks);
router.post("/", adminActionLimiter, adminAuthMiddleware, creditPackController.createCreditPack);
router.put("/:id", adminActionLimiter, adminAuthMiddleware, creditPackController.updateCreditPack);
router.delete("/:id", adminActionLimiter, adminAuthMiddleware, creditPackController.deleteCreditPack);

module.exports = router;
