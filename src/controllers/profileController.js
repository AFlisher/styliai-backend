"use strict";

const avatarService = require("../services/avatarService");

/**
 * POST /api/profile/avatar — R-2 phase 1.
 *
 * The file arrives through the shared upload middleware (memory storage, 10
 * MiB ceiling, magic-byte verification), and everything that decides whether
 * it is an acceptable avatar happens in avatarService against the decoded
 * bytes.
 */
async function uploadAvatar(req, res) {
  if (!req.file || !req.file.buffer) {
    return res.status(400).json({ message: "An image file is required." });
  }

  try {
    const { avatarUrl } = await avatarService.replaceAvatar({
      userId: req.user.id,
      buffer: req.file.buffer,
    });

    return res.status(200).json({ avatarUrl });
  } catch (err) {
    // A rejected file is the user's problem and is reported as such. Anything
    // else is ours: storage or the database failed, and the caller must not be
    // told to go and pick a different photo over it.
    if (err && err.isAvatarValidation) {
      return res.status(400).json({ message: err.message });
    }

    console.error(
      JSON.stringify({
        event: "avatar_upload_failed",
        userId: req.user && req.user.id,
        error: (err && err.message) || "unknown",
      })
    );
    return res.status(500).json({ message: "Could not update your profile photo." });
  }
}

module.exports = { uploadAvatar };
