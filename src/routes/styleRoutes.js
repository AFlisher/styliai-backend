const express = require("express");
const router = express.Router();

const styleController = require("../controllers/styleController");

router.get("/", styleController.getStyles);
router.post("/", styleController.createStyle);
router.put("/reorder", styleController.reorderStyles);
router.put("/:id", styleController.updateStyle);
router.delete("/:id", styleController.deleteStyle);

module.exports = router;