const express = require("express");
const router = express.Router();

const notificationController = require("../controllers/notificationController");
const authMiddleware = require("../middleware/authMiddleware");

router.use(authMiddleware);

router.get("/", notificationController.getNotifications);
// read-all is registered before /:id/read so it isn't captured as an id.
router.post("/read-all", notificationController.markAllRead);
router.post("/:id/read", notificationController.markRead);

module.exports = router;
