const supabase = require("../config/supabase");
const { v4: uuid } = require("uuid");

async function uploadImage(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({
        message: "No image uploaded."
      });
    }

    const fileExt = req.file.originalname.split(".").pop();

    const fileName = `${uuid()}.${fileExt}`;

    const { error } = await supabase.storage
      .from("style-images")
      .upload(fileName, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false,
      });

    if (error) throw error;

    const { data } = supabase.storage
      .from("style-images")
      .getPublicUrl(fileName);

    return res.json({
      url: data.publicUrl,
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

    let fileName;
    try {
      fileName = new URL(url).pathname.split("/").pop();
    } catch {
      return res.status(400).json({
        message: "Invalid image URL.",
      });
    }

    if (!fileName) {
      return res.status(400).json({
        message: "Invalid image URL.",
      });
    }

    const { error } = await supabase.storage
      .from("style-images")
      .remove([fileName]);

    if (error) throw error;

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