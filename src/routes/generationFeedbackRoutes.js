const express = require("express");
const router = express.Router();

const generationFeedbackController = require("../controllers/generationFeedbackController");
const authMiddleware = require("../middleware/authMiddleware");
const { userDataLimiter } = require("../middleware/rateLimiters");

router.use(userDataLimiter);
router.use(authMiddleware);

router.post("/", generationFeedbackController.submitFeedback);

module.exports = router;
