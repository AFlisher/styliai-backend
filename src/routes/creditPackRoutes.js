const express = require("express");
const router = express.Router();

const creditPackController = require("../controllers/creditPackController");
const adminAuthMiddleware = require("../middleware/adminAuthMiddleware");

router.get("/", creditPackController.getCreditPacks);
router.post("/", adminAuthMiddleware, creditPackController.createCreditPack);
router.put("/:id", adminAuthMiddleware, creditPackController.updateCreditPack);
router.delete("/:id", adminAuthMiddleware, creditPackController.deleteCreditPack);

module.exports = router;
