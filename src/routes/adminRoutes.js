const express = require("express");
const rateLimit = require("express-rate-limit");
const adminController = require("../controllers/adminController");
const adminStatsController = require("../controllers/adminStatsController");
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
router.get("/users/search", adminAuthMiddleware, adminController.searchUserByEmail);
router.post("/users/:id/adjust-balance", adminAuthMiddleware, adminController.adjustUserBalance);

module.exports = router;