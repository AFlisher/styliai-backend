const creditPackModel = require("../models/creditPackModel");

async function getCreditPacks(req, res) {
  try {
    const { all } = req.query;

    // Only return enabled packs by default, unless requested otherwise
    // (e.g. by the Admin Dashboard), matching styleController's convention.
    const filters = all === "true" ? {} : { isEnabled: true };

    const packs = await creditPackModel.getCreditPacks(filters);
    res.json(packs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to load credit packs." });
  }
}

async function createCreditPack(req, res) {
  try {
    const {
      name,
      credits,
      priceDisplay,
      badge = null,
      description = null,
      isEnabled = true,
      sortOrder,
    } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({ message: "Pack name is required." });
    }

    const numericCredits = Number(credits);
    if (!Number.isInteger(numericCredits) || numericCredits <= 0) {
      return res.status(400).json({ message: "Credits must be a positive whole number." });
    }

    if (!priceDisplay?.trim()) {
      return res.status(400).json({ message: "Price display text is required." });
    }

    const pack = await creditPackModel.createCreditPack({
      name: name.trim(),
      credits: numericCredits,
      priceDisplay: priceDisplay.trim(),
      badge,
      description,
      isEnabled,
      sortOrder,
    });

    res.status(201).json(pack);

  } catch (err) {
    console.error(err);

    if (err.code === "23505") {
      return res.status(409).json({ message: "A credit pack with this name already exists." });
    }

    res.status(500).json({ message: "Failed to create credit pack." });
  }
}

async function updateCreditPack(req, res) {
  try {
    const { id } = req.params;
    const {
      name,
      credits,
      priceDisplay,
      badge = null,
      description = null,
      isEnabled = true,
      sortOrder = 0,
    } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({ message: "Pack name is required." });
    }

    const numericCredits = Number(credits);
    if (!Number.isInteger(numericCredits) || numericCredits <= 0) {
      return res.status(400).json({ message: "Credits must be a positive whole number." });
    }

    if (!priceDisplay?.trim()) {
      return res.status(400).json({ message: "Price display text is required." });
    }

    const pack = await creditPackModel.updateCreditPack(id, {
      name: name.trim(),
      credits: numericCredits,
      priceDisplay: priceDisplay.trim(),
      badge,
      description,
      isEnabled,
      sortOrder,
    });

    if (!pack) {
      return res.status(404).json({ message: "Credit pack not found." });
    }

    res.json(pack);

  } catch (err) {
    console.error(err);

    if (err.code === "23505") {
      return res.status(409).json({ message: "A credit pack with this name already exists." });
    }

    res.status(500).json({ message: "Failed to update credit pack." });
  }
}

async function deleteCreditPack(req, res) {
  try {
    const { id } = req.params;

    const deleted = await creditPackModel.deleteCreditPack(id);
    if (!deleted) {
      return res.status(404).json({ message: "Credit pack not found." });
    }

    res.status(204).send();

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to delete credit pack." });
  }
}

module.exports = {
  getCreditPacks,
  createCreditPack,
  updateCreditPack,
  deleteCreditPack,
};
