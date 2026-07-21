const multer = require("multer");
const { verifyImageMagicBytes } = require("../utils/verifyImageContent");

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
    multerUpload.single(fieldName)(req, res, async (err) => {
      if (err) {
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
      }

      if (req.file && !(await verifyImageMagicBytes(req.file.buffer, ALLOWED_MIME_TYPES))) {
        return res.status(400).json({
          message: "Invalid file type. Only JPEG, PNG, WEBP, and GIF images are allowed.",
        });
      }

      next();
    });
  };
}

/**
 * Same wrapper as `single`, but accepts 1..maxCount files under one field
 * name (multi-image styles). A legacy single-file request is just an array
 * of one, so existing clients keep working unchanged.
 */
function array(fieldName, maxCount) {
  return function (req, res, next) {
    multerUpload.array(fieldName, maxCount)(req, res, async (err) => {
      if (err) {
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

        if (err.code === "LIMIT_UNEXPECTED_FILE") {
          return res.status(400).json({
            message: `Too many files. Maximum is ${maxCount} images.`,
          });
        }

        console.error("Upload error:", err.message);
        return res.status(400).json({
          message: "File upload failed.",
        });
      }

      const files = req.files || [];
      for (const file of files) {
        if (!(await verifyImageMagicBytes(file.buffer, ALLOWED_MIME_TYPES))) {
          return res.status(400).json({
            message: "Invalid file type. Only JPEG, PNG, WEBP, and GIF images are allowed.",
          });
        }
      }

      next();
    });
  };
}

module.exports = { single, array, fileFilter, ALLOWED_MIME_TYPES };
