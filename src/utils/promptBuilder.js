/**
 * Utility to builder clean prompt payloads for StyliAI.
 * Combines positive prompts and optional negative prompts.
 */

/**
 * Combines style positive and negative prompts.
 * @param {Object} style - The style model query result.
 * @returns {Object} An object containing the positive prompt and negative prompt.
 */
function buildPrompt(style) {
  if (!style) {
    throw new Error("Style data is required to build a prompt.");
  }

  return {
    prompt: style.prompt || "",
    negativePrompt: style.negativePrompt || ""
  };
}

module.exports = {
  buildPrompt
};
