const express = require("express");
const router = express.Router();

const creationsController = require("../controllers/creationsController");
const authMiddleware = require("../middleware/authMiddleware");
const { userDataLimiter } = require("../middleware/rateLimiters");

router.use(userDataLimiter);
router.use(authMiddleware);

router.get("/", creationsController.getCreations);
router.post("/migrate", creationsController.migrateCreations);

// SEC-8.1B-2: stable, authenticated delivery addresses. Declared before
// "/:id" so neither is captured as an id, and both sit behind the same
// authMiddleware + userDataLimiter as every other route in this file.
router.get("/:id/image", creationsController.getCreationImage("image"));
router.get("/:id/thumbnail", creationsController.getCreationImage("thumbnail"));

router.delete("/:id", creationsController.deleteCreation);

module.exports = router;
