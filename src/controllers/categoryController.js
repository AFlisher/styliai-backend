const categoryModel = require("../models/categoryModel");

async function getCategories(req, res) {
  try {
    const categories = await categoryModel.getAllCategories();

    res.json(categories);
  } catch (err) {
    console.error(err);

    res.status(500).json({
      message: "Failed to load categories.",
    });
  }
}

async function createCategory(req, res) {
  try {
    const { name, isEnabled = true } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({
        message: "Category name is required.",
      });
    }

    const category = await categoryModel.createCategory({
      name: name.trim(),
      isEnabled,
    });

    res.status(201).json(category);

  } catch (err) {
  console.error(err);

  if (err.code === "23505") {
    return res.status(409).json({
      message: "A category with this name already exists."
    });
  }

  return res.status(500).json({
    message: "Failed to create category."
  });
 }
}

async function updateCategory(req, res) {
  try {
    const { id } = req.params;
    const { name, isEnabled, sortOrder } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({
        message: "Category name is required.",
      });
    }

    const category = await categoryModel.updateCategory(id, {
      name: name.trim(),
      isEnabled,
      sortOrder,
    });

    if (!category) {
      return res.status(404).json({
        message: "Category not found.",
      });
    }

    res.json(category);

  } catch (err) {
    console.error(err);
    if (err.code === "23505") {
         return res.status(409).json({
         message: "A category with this name already exists."
     });
    }

    res.status(500).json({
      message: "Failed to update category.",
    });
  }
}

async function deleteCategory(req, res) {
  try {
    const { id } = req.params;

    const result = await categoryModel.deleteCategory(id);

    if (result.hasStyles) {
      return res.status(409).json({
        message: "This category contains styles. Delete or move the styles first."
      });
    }

    if (!result.deleted) {
      return res.status(404).json({
        message: "Category not found."
      });
    }

    return res.status(204).send();

  } catch (err) {
    console.error(err);

    return res.status(500).json({
      message: "Failed to delete category."
    });
  }
}
async function reorderCategories(req, res) {
  try {
    const { categories } = req.body;

    if (!Array.isArray(categories)) {
      return res.status(400).json({
        message: "Categories array is required."
      });
    }

    await categoryModel.reorderCategories(categories);

    return res.json({
      message: "Categories reordered successfully."
    });

  } catch (err) {
    console.error(err);

    return res.status(500).json({
      message: "Failed to reorder categories."
    });
  }
}

module.exports = {
  getCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  reorderCategories,
};