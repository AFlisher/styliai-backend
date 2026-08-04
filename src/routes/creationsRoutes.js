const express = require("express");
const router = express.Router();

const creationsController = require("../controllers/creationsController");
const authMiddleware = require("../middleware/authMiddleware");
const { userDataLimiter } = require("../middleware/rateLimiters");
const { uuidParams } = require("../middleware/validateRequest");

router.use(userDataLimiter);
router.use(authMiddleware);

router.get("/", creationsController.getCreations);
router.post("/migrate", creationsController.migrateCreations);

// SEC-9.1: every ":id" below reaches a `uuid` column. Validating here means a
// malformed id is refused before it can occupy a pooled connection (and, since
// SEC-19.3, a statement-timeout budget) only to be rejected by Postgres as
// 22P02 - which is the specific path that used to answer 500.
//
// SEC-8.1B-2: stable, authenticated delivery addresses. Declared before
// "/:id" so neither is captured as an id, and both sit behind the same
// authMiddleware + userDataLimiter as every other route in this file.
router.get("/:id/image", uuidParams("id"), creationsController.getCreationImage("image"));
router.get("/:id/thumbnail", uuidParams("id"), creationsController.getCreationImage("thumbnail"));

router.delete("/:id", uuidParams("id"), creationsController.deleteCreation);

module.exports = router;
