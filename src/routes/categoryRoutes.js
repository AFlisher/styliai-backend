const express = require("express");
const router = express.Router();

const categoryController = require("../controllers/categoryController");
const adminAuthMiddleware = require("../middleware/adminAuthMiddleware");
const { publicReadLimiter, adminActionLimiter } = require("../middleware/rateLimiters");

router.get("/", publicReadLimiter, categoryController.getCategories);

router.post("/", adminActionLimiter, adminAuthMiddleware, categoryController.createCategory);

router.put("/reorder", adminActionLimiter, adminAuthMiddleware, categoryController.reorderCategories);

router.put("/:id", adminActionLimiter, adminAuthMiddleware, categoryController.updateCategory);

router.delete("/:id", adminActionLimiter, adminAuthMiddleware, categoryController.deleteCategory);
module.exports = router;
