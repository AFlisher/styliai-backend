const express = require("express");
const router = express.Router();

const { uploadSingleImage } = require("../middleware/adminImageUpload");
const adminAuthMiddleware = require("../middleware/adminAuthMiddleware");
const uploadController = require("../controllers/uploadController");

router.post(
  "/",
  adminAuthMiddleware,
  uploadSingleImage("file"),
  uploadController.uploadImage
);

module.exports = router;