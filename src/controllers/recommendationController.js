const recommendationService = require("../services/recommendationService");

async function getSimilarStyles(req, res) {
  try {
    const { id } = req.params;
    const limit = Number(req.query.limit) || 10;

    const styles = await recommendationService.getSimilarStyles({ styleId: id, limit });

    if (styles === null) {
      return res.status(404).json({
        message: "Style not found.",
      });
    }

    res.json(styles);
  } catch (err) {
    console.error(err);

    res.status(500).json({
      message: "Failed to load similar styles.",
    });
  }
}

module.exports = {
  getSimilarStyles,
};
