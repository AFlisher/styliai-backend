const express = require("express");
const router = express.Router();

const creationsController = require("../controllers/creationsController");
const authMiddleware = require("../middleware/authMiddleware");

router.use(authMiddleware);

router.get("/", creationsController.getCreations);
router.post("/migrate", creationsController.migrateCreations);
router.delete("/:id", creationsController.deleteCreation);

module.exports = router;
