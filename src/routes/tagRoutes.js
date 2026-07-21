const express = require("express");
const router = express.Router();

const tagController = require("../controllers/tagController");
const adminAuthMiddleware = require("../middleware/adminAuthMiddleware");
const { adminActionLimiter } = require("../middleware/rateLimiters");

// Tags are internal ranking metadata curated by the Admin Dashboard only -
// unlike /api/categories, there is no mobile-facing reason to list them, so
// every route here (including reads) requires an admin token.
router.use(adminActionLimiter);
router.use(adminAuthMiddleware);

router.get("/", tagController.getTags);
router.post("/", tagController.createTag);
router.put("/:id", tagController.updateTag);
router.delete("/:id", tagController.deleteTag);

module.exports = router;
