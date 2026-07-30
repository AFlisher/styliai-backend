"use strict";

const avatarService = require("../services/avatarService");
const {
  logAuditEvent,
  logUploadFailure,
  logUnexpectedError,
} = require("../utils/securityEvents");

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

    logAuditEvent(req, { action: "avatar_upload", subject: req.user.id });
    return res.status(200).json({ avatarUrl });
  } catch (err) {
    // A rejected file is the user's problem and is reported as such. Anything
    // else is ours: storage or the database failed, and the caller must not be
    // told to go and pick a different photo over it.
    if (err && err.isAvatarValidation) {
      // A rejected image is the validation layer working, not a fault: it is
      // recorded as an upload failure with the stage that refused it, so a
      // spike is visible without drowning the error stream.
      logUploadFailure(req, { stage: "avatar_validation", reason: "rejected", bucket: "avatars" });
      return res.status(400).json({ message: err.message });
    }

    logUploadFailure(req, { stage: "avatar_store", reason: "storage_or_db_failed", bucket: "avatars" });
    logUnexpectedError(req, err, { where: "uploadAvatar" });
    return res.status(500).json({ message: "Could not update your profile photo." });
  }
}

/**
 * GET /api/profile/avatar — R-2 phase 4.
 *
 * Authorizes by identity and then redirects to a short-lived signed URL, the
 * same shape SEC-8.1B-2 uses for creations: the bytes still come from storage's
 * CDN, only the decision travels through this process.
 *
 * Deliberately takes no id. The caller can only ever ask for their own avatar,
 * so there is nothing to enumerate and no ownership check to get wrong.
 */
async function getAvatar(req, res) {
  try {
    const delivery = await avatarService.resolveAvatarDelivery(req.user.id);

    if (delivery.kind === "none") {
      return res.status(404).json({ message: "No profile photo set." });
    }

    // The redirect must never be cached: its target expires, and a cached 302
    // would keep sending the client at a dead signature. The image itself is
    // cached by the client under the stable URL, which is what makes this
    // affordable.
    res.set("Cache-Control", "private, no-store");
    return res.redirect(302, delivery.url);
  } catch (err) {
    logUnexpectedError(req, err, { where: "getAvatar" });
    return res.status(502).json({ message: "Profile photo is temporarily unavailable." });
  }
}

module.exports = { uploadAvatar, getAvatar };
