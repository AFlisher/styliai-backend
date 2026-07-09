const generationService = require("../services/generation/generationService");

/**
 * Controller to handle AI style generation requests.
 * Validates request payloads and invokes the generation orchestrator service.
 */
async function generateImage(req, res) {
  try {
    const { styleId } = req.body;

    // 1. Validation checks
    if (!req.file) {
      return res.status(400).json({
        message: "Source image file is required."
      });
    }

    if (!styleId) {
      return res.status(400).json({
        message: "styleId is required."
      });
    }

    // 2. Invoke generation orchestration service
    const generatedImageUrl = await generationService.generate(req.file, styleId);

    // 3. Return JSON payload
    return res.status(200).json({
      success: true,
      generatedImageUrl
    });

  } catch (err) {
    console.error("AI Generation Controller Error:", err);

    if (err.message === "Style preset not found.") {
      return res.status(404).json({
        message: err.message
      });
    }

    return res.status(500).json({
      message: err.message || "An error occurred during image style generation."
    });
  }
}

module.exports = {
  generateImage
};
