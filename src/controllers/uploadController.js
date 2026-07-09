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

module.exports = {
  uploadImage,
};