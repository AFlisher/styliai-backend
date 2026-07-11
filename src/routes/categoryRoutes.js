const express = require("express");
const router = express.Router();

const categoryController = require("../controllers/categoryController");
const adminAuthMiddleware = require("../middleware/adminAuthMiddleware");

router.get("/", categoryController.getCategories);

router.post("/", adminAuthMiddleware, categoryController.createCategory);

router.put("/reorder", adminAuthMiddleware, categoryController.reorderCategories);

router.put("/:id", adminAuthMiddleware, categoryController.updateCategory);

router.delete("/:id", adminAuthMiddleware, categoryController.deleteCategory);
module.exports = router;