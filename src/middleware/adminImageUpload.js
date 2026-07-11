const multer = require("multer");

// Strict allow-list for the admin-only image upload endpoint.
// Kept separate from src/middleware/upload.js (used by /api/generate) so that
// tightening this filter can never change behavior for the generation endpoint.
const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

const storage = multer.memoryStorage();

const imageUpload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
  fileFilter(req, file, cb) {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      return cb(new Error("INVALID_FILE_TYPE"));
    }
    cb(null, true);
  },
});

function uploadSingleImage(fieldName) {
  return function (req, res, next) {
    imageUpload.single(fieldName)(req, res, (err) => {
      if (!err) {
        return next();
      }

      if (err.message === "INVALID_FILE_TYPE") {
        return res.status(400).json({
          message: "Invalid file type. Only JPEG, PNG, WEBP, and GIF images are allowed.",
        });
      }

      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({
          message: "File is too large. Maximum size is 10MB.",
        });
      }

      console.error("Upload error:", err.message);
      return res.status(400).json({
        message: "File upload failed.",
      });
    });
  };
}

module.exports = { uploadSingleImage };
