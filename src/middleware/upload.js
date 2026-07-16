const multer = require("multer");

// Same image allow-list as the admin upload (src/middleware/adminImageUpload.js):
// /api/generate forwards the file to storage and the paid AI provider, so
// arbitrary payloads are rejected up front instead of being passed through.
const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

const storage = multer.memoryStorage();

function fileFilter(req, file, cb) {
  if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
    return cb(new Error("INVALID_FILE_TYPE"));
  }
  cb(null, true);
}

const multerUpload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
  fileFilter,
});

// Exposes the same `upload.single(field)` shape the routes already use, but
// wrapped so filter/size failures answer with a 400 instead of falling
// through to the generic 500 error handler.
function single(fieldName) {
  return function (req, res, next) {
    multerUpload.single(fieldName)(req, res, (err) => {
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

module.exports = { single, fileFilter, ALLOWED_MIME_TYPES };
