const express = require("express");
const router = express.Router();

const upload = require("../middleware/upload");
const authMiddleware = require("../middleware/authMiddleware");
const profileController = require("../controllers/profileController");
const { userDataLimiter, avatarUploadLimiter } = require("../middleware/rateLimiters");

// R-2 phase 1. Auth sits BEFORE multer, following the ordering established in
// uploadRoutes.js for SEC-15.4: an unauthenticated caller is refused without
// the request body ever being parsed or buffered into memory.
//
// `upload.single` is the existing shared middleware, reused rather than
// re-implemented: memory storage, a 10 MiB ceiling, and - the part that
// matters - verifyImageMagicBytes on the buffer, so a relabelled non-image is
// rejected before it reaches the controller. Its allow-list also admits GIF,
// which avatarService then refuses on the decoded format.
// Phase 6: its own limiter rather than the generic userDataLimiter. This
// endpoint decodes and re-encodes every image server-side, so a request costs
// real CPU - the shared budget was sized for cheap JSON reads.
//
// Order is load-bearing, and is the same reorder SEC-15.8 required: keying a
// limiter on identity means auth must run BEFORE it, or `req.user` does not
// exist when the key is computed and the limiter silently falls back to the IP.
// That would put every user behind one NAT into a shared budget of 10.
//
// The trade-off, accepted as it was there: an unauthenticated flood no longer
// consumes this limiter. It does not need to - those requests are rejected by
// authMiddleware before multer buffers a single byte, which is also why auth
// still precedes the upload middleware.
router.post(
  "/avatar",
  authMiddleware,
  avatarUploadLimiter,
  upload.single("avatar"),
  profileController.uploadAvatar
);

// R-2 phase 4. Stable, authenticated delivery address for the caller's own
// avatar. No id in the path, so there is nothing to enumerate.
router.get("/avatar", userDataLimiter, authMiddleware, profileController.getAvatar);

module.exports = router;
