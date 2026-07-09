const express = require("express");
const rateLimit = require("express-rate-limit");
const adminController = require("../controllers/adminController");

const router = express.Router();

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

router.post("/login", limiter, adminController.login);

module.exports = router;