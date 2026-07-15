const styleModel = require("../models/styleModel");
const categoryModel = require("../models/categoryModel");
const recommendationService = require("../services/recommendationService");
const autoTagService = require("../services/autoTagService");
const { PromptValidationError, assertUniqueKeys } = require("../utils/promptTemplate");

/**
 * Validates admin-supplied dynamic field definitions before any DB write, so a
 * bad set is rejected with 400 up front. `undefined` means "leave fields
 * untouched"; an array (incl. empty) is validated and will be persisted.
 */
function validateFieldsInput(fields) {
  if (fields === undefined) return;
  if (!Array.isArray(fields)) {
    throw new PromptValidationError("fields must be an array.");
  }
  assertUniqueKeys(fields);
}

async function resolveCategoryName(categoryId) {
  const categories = await categoryModel.getAllCategories();
  return categories.find((c) => c.id === categoryId)?.name ?? "";
}

async function getStyles(req, res) {
  try {
    const { categoryId, all, trending, recommended } = req.query;

    // ?recommended=true powers the Home screen's "Recommended For You"
    // section. This branches out before any of the category/trending
    // filters below because it's a completely different query shape
    // (ranked-by-RecommendationService, not a plain WHERE filter) - and,
    // critically, the personalization-off/anonymous checks here must run
    // BEFORE recommendationService is ever called, so a user with
    // personalization off has their favorites/creations never even queried.
    if (recommended === "true") {
      if (!req.user) {
        return res.json([]);
      }

      const enabled = await recommendationService.isPersonalizationEnabled(req.user.id);
      if (!enabled) {
        return res.json([]);
      }

      const recommendations = await recommendationService.getPersonalizedRecommendations({
        userId: req.user.id,
      });
      return res.json(recommendations);
    }

    const filters = {};
    if (categoryId) {
      filters.categoryId = categoryId;
    }

    // Only return enabled styles by default, unless requested otherwise (e.g. by Admin dashboard)
    if (all !== "true") {
      filters.isEnabled = true;
    }

    // ?trending=true powers the Home screen's dynamic Trending section: every
    // enabled style flagged isTrending, regardless of category. There is no
    // dedicated Trending category - this is a filtered read of the same
    // styles rows used everywhere else, so a style stays in its real
    // category and nothing is duplicated.
    if (trending === "true") {
      filters.isTrending = true;
    }

    // req.admin is only set by optionalAdminAuth when a valid admin token was
    // presented (the Admin Dashboard always sends one). Anyone else -
    // including the mobile app, which never holds an admin token - gets the
    // public DTO with no prompt/negativePrompt/generation-config/tagIds fields.
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
      tagIds = [],
      autoAssignTags = true,
      fields,
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

    validateFieldsInput(fields);

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

    // autoAssignTags defaults to true - a new style is auto-tagged unless
    // the admin explicitly built a manual tag selection before first save.
    let finalTagIds = tagIds;
    let tagsAutoAssigned = false;
    if (autoAssignTags !== false) {
      const categoryName = await resolveCategoryName(categoryId);
      const suggestion = await autoTagService.suggestTagsForStyle({
        name: name.trim(),
        prompt: prompt.trim(),
        categoryName,
      });
      // Even on 'error', tagIds ends up [] with tagsAutoAssigned true - this
      // self-heals via backfillTags.js's next run (it targets exactly this:
      // tags_auto_assigned = true AND currently untagged), no special
      // retry logic needed here.
      finalTagIds = suggestion.tagIds;
      tagsAutoAssigned = true;
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
      tagIds: finalTagIds,
      tagsAutoAssigned,
      fields,
    });
    recommendationService.invalidateCandidateCache();

    res.status(201).json(style);

  } catch (err) {
    if (err instanceof PromptValidationError) {
      return res.status(400).json({ message: err.message });
    }

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
      tagIds,
      autoAssignTags,
      fields,
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

    validateFieldsInput(fields);

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

    // The tag pipeline only ever runs when the caller explicitly says so via
    // autoAssignTags - it's always present from the real Style-modal save
    // flow, never present from the toggle-only quick actions (isTrending/
    // isPremium/isEnabled), so there's no risk of an unrelated toggle
    // silently re-triggering classification. Left undefined here, tagIds
    // stays whatever the client sent (possibly also undefined), preserving
    // styleModel.updateStyle's existing "leave tags untouched" behavior.
    let finalTagIds = tagIds;
    let tagsAutoAssigned;
    if (autoAssignTags === false) {
      finalTagIds = tagIds;
      tagsAutoAssigned = false;
    } else if (autoAssignTags === true) {
      const categoryName = await resolveCategoryName(categoryId);
      const suggestion = await autoTagService.suggestTagsForStyle({
        name: name.trim(),
        prompt: prompt.trim(),
        categoryName,
      });

      if (suggestion.status === "error") {
        // Never wipe existing tags on a transient classification failure -
        // leave both fields untouched (styleModel.updateStyle's COALESCE/
        // undefined-guard preserves whatever's already stored).
        finalTagIds = undefined;
        tagsAutoAssigned = undefined;
      } else {
        finalTagIds = suggestion.tagIds;
        tagsAutoAssigned = true;
      }
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
      tagIds: finalTagIds,
      tagsAutoAssigned,
      fields,
    });

    if (!style) {
      return res.status(404).json({
        message: "Style not found.",
      });
    }
    recommendationService.invalidateCandidateCache();

    return res.json(style);

  } catch (err) {
    if (err instanceof PromptValidationError) {
      return res.status(400).json({ message: err.message });
    }

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
    recommendationService.invalidateCandidateCache();

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