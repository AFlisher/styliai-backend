const express = require("express");
const router = express.Router();

const { uploadSingleImage } = require("../middleware/adminImageUpload");
const adminAuthMiddleware = require("../middleware/adminAuthMiddleware");
const { requireAdminRoleFor } = require("../middleware/requireAdminRole");
const uploadController = require("../controllers/uploadController");
const { uploadLimiter } = require("../middleware/rateLimiters");

// SEC-15.4: the role guard sits BEFORE multer, so an under-privileged caller is
// refused without the request body ever being parsed or buffered into memory.
router.post(
  "/",
  uploadLimiter,
  adminAuthMiddleware,
  requireAdminRoleFor("POST /api/upload"),
  uploadSingleImage("file"),
  uploadController.uploadImage
);

router.delete(
  "/",
  uploadLimiter,
  adminAuthMiddleware,
  requireAdminRoleFor("DELETE /api/upload"),
  uploadController.deleteImage
);

module.exports = router;
