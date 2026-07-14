const tagModel = require("../models/tagModel");
const recommendationService = require("../services/recommendationService");

async function getTags(req, res) {
  try {
    const tags = await tagModel.getAllTags();

    res.json(tags);
  } catch (err) {
    console.error(err);

    res.status(500).json({
      message: "Failed to load tags.",
    });
  }
}

async function createTag(req, res) {
  try {
    const { name, isEnabled = true } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({
        message: "Tag name is required.",
      });
    }

    const tag = await tagModel.createTag({
      name: name.trim(),
      isEnabled,
    });
    recommendationService.invalidateCandidateCache();

    res.status(201).json(tag);

  } catch (err) {
    console.error(err);

    if (err.code === "23505") {
      return res.status(409).json({
        message: "A tag with this name already exists.",
      });
    }

    res.status(500).json({
      message: "Failed to create tag.",
    });
  }
}

async function updateTag(req, res) {
  try {
    const { id } = req.params;
    const { name, isEnabled } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({
        message: "Tag name is required.",
      });
    }

    const tag = await tagModel.updateTag(id, {
      name: name.trim(),
      isEnabled,
    });

    if (!tag) {
      return res.status(404).json({
        message: "Tag not found.",
      });
    }
    recommendationService.invalidateCandidateCache();

    res.json(tag);

  } catch (err) {
    console.error(err);

    if (err.code === "23505") {
      return res.status(409).json({
        message: "A tag with this name already exists.",
      });
    }

    res.status(500).json({
      message: "Failed to update tag.",
    });
  }
}

async function deleteTag(req, res) {
  try {
    const { id } = req.params;

    const tag = await tagModel.deleteTag(id);

    if (!tag) {
      return res.status(404).json({
        message: "Tag not found.",
      });
    }
    recommendationService.invalidateCandidateCache();

    return res.status(204).send();

  } catch (err) {
    console.error(err);

    return res.status(500).json({
      message: "Failed to delete tag.",
    });
  }
}

module.exports = {
  getTags,
  createTag,
  updateTag,
  deleteTag,
};
