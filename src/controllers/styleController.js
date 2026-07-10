const styleModel = require("../models/styleModel");

async function getStyles(req, res) {
  try {
    const { categoryId, all } = req.query;

    const filters = {};
    if (categoryId) {
      filters.categoryId = categoryId;
    }
    
    // Only return enabled styles by default, unless requested otherwise (e.g. by Admin dashboard)
    if (all !== "true") {
      filters.isEnabled = true;
    }

    const styles = await styleModel.getStyles(filters);
    res.json(styles);
  } catch (err) {
    console.error(err);

    res.status(500).json({
      message: "Failed to load styles.",
    });
  }
}

async function createStyle(req, res) {
  try {
    const {
      categoryId,
      name,
      prompt,
      negativePrompt = null,
      coverImage = null,
      creditsCost,
      creditCost = 1,
      isTrending = false,
      isPremium = false,
      isEnabled = true,
      sortOrder = 0,
    } = req.body;

    if (!categoryId) {
      return res.status(400).json({
        message: "Category is required.",
      });
    }

    if (!name?.trim()) {
      return res.status(400).json({
        message: "Style name is required.",
      });
    }

    if (!prompt?.trim()) {
      return res.status(400).json({
        message: "Prompt is required.",
      });
    }

    const style = await styleModel.createStyle({
      categoryId,
      name: name.trim(),
      prompt: prompt.trim(),
      negativePrompt,
      coverImage,
      creditsCost,
      creditCost: Number(creditCost) || 1,
      isTrending,
      isPremium,
      isEnabled,
      sortOrder,
    });

    res.status(201).json(style);

  } catch (err) {
    console.error(err);

    if (err.code === "23505") {
      return res.status(409).json({
        message: "A style with this name already exists in this category."
      });
    }

    res.status(500).json({
      message: "Failed to create style.",
    });
  }
}

async function updateStyle(req, res) {
  try {
    const { id } = req.params;

    const {
      categoryId,
      name,
      prompt,
      negativePrompt = null,
      coverImage = null,
      creditsCost,
      creditCost = 1,
      isTrending = false,
      isPremium = false,
      isEnabled = true,
      sortOrder = 0,
    } = req.body;

    if (!categoryId) {
      return res.status(400).json({
        message: "Category is required.",
      });
    }

    if (!name?.trim()) {
      return res.status(400).json({
        message: "Style name is required.",
      });
    }

    if (!prompt?.trim()) {
      return res.status(400).json({
        message: "Prompt is required.",
      });
    }

    const style = await styleModel.updateStyle(id, {
      categoryId,
      name: name.trim(),
      prompt: prompt.trim(),
      negativePrompt,
      coverImage,
      creditsCost,
      creditCost: Number(creditCost) || 1,
      isTrending,
      isPremium,
      isEnabled,
      sortOrder,
    });

    if (!style) {
      return res.status(404).json({
        message: "Style not found.",
      });
    }

    return res.json(style);

  } catch (err) {
    console.error(err);

    if (err.code === "23505") {
      return res.status(409).json({
        message: "A style with this name already exists in this category.",
      });
    }

    return res.status(500).json({
      message: "Failed to update style.",
    });
  }
}

async function deleteStyle(req, res) {
  try {
    const { id } = req.params;

    const style = await styleModel.deleteStyle(id);

    if (!style) {
      return res.status(404).json({
        message: "Style not found.",
      });
    }

    return res.status(204).send();

  } catch (err) {
    console.error(err);

    return res.status(500).json({
      message: "Failed to delete style.",
    });
  }
}

async function reorderStyles(req, res) {
  try {
    const { styles } = req.body;

    if (!Array.isArray(styles)) {
      return res.status(400).json({
        message: "Styles array is required.",
      });
    }

    await styleModel.reorderStyles(styles);

    return res.json({
      message: "Styles reordered successfully.",
    });

  } catch (err) {
    console.error(err);

    return res.status(500).json({
      message: "Failed to reorder styles.",
    });
  }
}

module.exports = {
  getStyles,
  createStyle,
  updateStyle,
  deleteStyle,
  reorderStyles,
};