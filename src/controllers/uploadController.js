const imageStorageService = require("../services/imageStorageService");

const STYLE_IMAGES_BUCKET = "style-images";

async function uploadImage(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({
        message: "No image uploaded."
      });
    }

    const { url, thumbnailUrl } = await imageStorageService.uploadOriginalWithThumbnail({
      buffer: req.file.buffer,
      mimeType: req.file.mimetype,
      bucket: STYLE_IMAGES_BUCKET,
    });

    return res.json({
      url,
      thumbnailUrl,
    });

  } catch (err) {
    console.error(err);

    return res.status(500).json({
      message: "Image upload failed.",
    });
  }
}

async function deleteImage(req, res) {
  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({
        message: "Image URL is required.",
      });
    }

    try {
      await imageStorageService.deleteOriginalAndThumbnail({ bucket: STYLE_IMAGES_BUCKET, url });
    } catch (err) {
      if (err.message === "INVALID_IMAGE_URL") {
        return res.status(400).json({
          message: "Invalid image URL.",
        });
      }
      throw err;
    }

    return res.status(204).send();

  } catch (err) {
    console.error(err);

    return res.status(500).json({
      message: "Image deletion failed.",
    });
  }
}

module.exports = {
  uploadImage,
  deleteImage,
};
