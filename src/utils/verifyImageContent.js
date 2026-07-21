const FileType = require("file-type");

/**
 * Confirms a file's actual bytes (magic number), not just its client-supplied
 * Content-Type, match one of the allowed image MIME types. multer's fileFilter
 * only sees the multipart part's declared Content-Type header, which a client
 * fully controls - this runs after the buffer is available to catch a
 * relabeled non-image payload that passed the header check.
 */
async function verifyImageMagicBytes(buffer, allowedMimeTypes) {
  try {
    const detected = await FileType.fromBuffer(buffer);
    return Boolean(detected && allowedMimeTypes.has(detected.mime));
  } catch (err) {
    // Buffer too short/malformed for signature detection (e.g. truncated
    // upload) - fail closed rather than let an unrecognizable payload through.
    return false;
  }
}

module.exports = { verifyImageMagicBytes };
