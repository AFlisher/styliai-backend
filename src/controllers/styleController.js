const styleModel = require("../models/styleModel");

async function getStyles(req, res) {
  try {
    const styles = await styleModel.getAllStyles();
    res.json(styles);
  } catch (err) {
    console.error(err);

    res.status(500).json({
      message: "Failed to load styles.",
    });
  }
}

module.exports = {
  getStyles,
};