const express = require("express");
const router = express.Router();

const styleController = require("../controllers/styleController");
const adminAuthMiddleware = require("../middleware/adminAuthMiddleware");
const { optionalAdminAuth } = require("../middleware/adminAuthMiddleware");

router.get("/", optionalAdminAuth, styleController.getStyles);
router.post("/", adminAuthMiddleware, styleController.createStyle);
router.put("/reorder", adminAuthMiddleware, styleController.reorderStyles);
router.put("/:id", adminAuthMiddleware, styleController.updateStyle);
router.delete("/:id", adminAuthMiddleware, styleController.deleteStyle);

module.exports = router;