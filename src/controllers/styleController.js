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

    // req.admin is only set by optionalAdminAuth when a valid admin token was
    // presented (the Admin Dashboard always sends one). Anyone else -
    // including the mobile app, which never holds an admin token - gets the
    // public DTO with no prompt/negativePrompt/generation-config fields.
    const styles = req.admin
      ? await styleModel.getStyles(filters)
      : await styleModel.getPublicStyles(filters);
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
      creditCost,
      isTrending = false,
      isPremium = false,
      isEnabled = true,
      sortOrder,
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

    let parsedCreditCost = 1;
    if (creditCost !== undefined) {
      const numericCreditCost = Number(creditCost);
      if (!Number.isInteger(numericCreditCost) || numericCreditCost < 0) {
        return res.status(400).json({
          message: "Credit cost must be a non-negative whole number.",
        });
      }
      parsedCreditCost = numericCreditCost;
    }

    // sortOrder is intentionally left undefined when the caller doesn't
    // provide one - styleModel.createStyle appends the new style to the
    // end of its category instead of defaulting to 0.
    const style = await styleModel.createStyle({
      categoryId,
      name: name.trim(),
      prompt: prompt.trim(),
      negativePrompt,
      coverImage,
      creditCost: parsedCreditCost,
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
      creditCost,
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

    let parsedCreditCost = 1;
    if (creditCost !== undefined) {
      const numericCreditCost = Number(creditCost);
      if (!Number.isInteger(numericCreditCost) || numericCreditCost < 0) {
        return res.status(400).json({
          message: "Credit cost must be a non-negative whole number.",
        });
      }
      parsedCreditCost = numericCreditCost;
    }

    const style = await styleModel.updateStyle(id, {
      categoryId,
      name: name.trim(),
      prompt: prompt.trim(),
      negativePrompt,
      coverImage,
      creditCost: parsedCreditCost,
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