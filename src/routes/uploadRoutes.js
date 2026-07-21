const express = require("express");
const router = express.Router();

const { uploadSingleImage } = require("../middleware/adminImageUpload");
const adminAuthMiddleware = require("../middleware/adminAuthMiddleware");
const uploadController = require("../controllers/uploadController");
const { uploadLimiter } = require("../middleware/rateLimiters");

router.post(
  "/",
  uploadLimiter,
  adminAuthMiddleware,
  uploadSingleImage("file"),
  uploadController.uploadImage
);

router.delete(
  "/",
  uploadLimiter,
  adminAuthMiddleware,
  uploadController.deleteImage
);

module.exports = router;
