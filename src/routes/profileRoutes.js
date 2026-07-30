const express = require("express");
const router = express.Router();

const upload = require("../middleware/upload");
const authMiddleware = require("../middleware/authMiddleware");
const profileController = require("../controllers/profileController");
const { userDataLimiter } = require("../middleware/rateLimiters");

// R-2 phase 1. Auth sits BEFORE multer, following the ordering established in
// uploadRoutes.js for SEC-15.4: an unauthenticated caller is refused without
// the request body ever being parsed or buffered into memory.
//
// `upload.single` is the existing shared middleware, reused rather than
// re-implemented: memory storage, a 10 MiB ceiling, and - the part that
// matters - verifyImageMagicBytes on the buffer, so a relabelled non-image is
// rejected before it reaches the controller. Its allow-list also admits GIF,
// which avatarService then refuses on the decoded format.
router.post(
  "/avatar",
  userDataLimiter,
  authMiddleware,
  upload.single("avatar"),
  profileController.uploadAvatar
);

// R-2 phase 4. Stable, authenticated delivery address for the caller's own
// avatar. No id in the path, so there is nothing to enumerate.
router.get("/avatar", userDataLimiter, authMiddleware, profileController.getAvatar);

module.exports = router;
