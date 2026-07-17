"use strict";
/**
 * GeminiProvider — Image editing/generation using the official @google/genai SDK.
 *
 * Responsibilities:
 *   - Accept an image buffer + text prompt.
 *   - Send the image as inline base64 data (never as a URL).
 *   - Request an IMAGE response from the model.
 *   - Return the generated image as a Node.js Buffer.
 *
 * Isolation contract:
 *   The public method signature must remain stable so that this provider can
 *   be swapped out for any other provider (e.g., Nano Banana) without touching
 *   generationService.js:
 *
 *     provider.generateImage({ imageBuffer, mimeType, prompt, negativePrompt })
 *       → Promise<Buffer>
 */

const { GoogleGenAI } = require("@google/genai");

/**
 * The Gemini model used for image editing (multimodal input → image output).
 * gemini-2.0-flash-preview-image-generation supports image output modality
 * and accepts inline image input via inlineData parts.
 */
const GENERATION_MODEL =
    process.env.GEMINI_MODEL || "gemini-2.5-flash-image";
    
class GeminiProvider {
  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "[GeminiProvider] GEMINI_API_KEY is not defined in environment variables."
      );
    }

    /**
     * GoogleGenAI client from the official @google/genai SDK.
     * All API calls are made through this.ai.models.*.
     */
    this.ai = new GoogleGenAI({ apiKey });
  }

  /**
   * Generates a styled image from a source image buffer and text prompts.
   *
   * @param {Object} params
   * @param {Buffer}  params.imageBuffer     - Raw binary image from the user (Multer buffer).
   * @param {string}  params.mimeType        - MIME type of the input image (e.g. "image/jpeg").
   * @param {string}  params.prompt          - Positive style prompt from the style preset.
   * @param {string}  [params.negativePrompt] - Optional negative instructions.
   *
   * @returns {Promise<Buffer>} The generated image as a Node.js Buffer.
   */
  async generateImage({ imageBuffer, mimeType, images, prompt, negativePrompt }) {
    // Normalize to a list of source images. `images` (multi-image styles)
    // wins when provided; otherwise the classic single imageBuffer is used.
    const sources = images?.length
      ? images
      : [{ buffer: imageBuffer, mimeType }];

    // --- Input validation -------------------------------------------------
    for (const src of sources) {
      if (!Buffer.isBuffer(src.buffer) || src.buffer.length === 0) {
        throw new Error("[GeminiProvider] every image must be a non-empty Buffer.");
      }
    }
    if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
      throw new Error("[GeminiProvider] A non-empty prompt string is required.");
    }

    // --- Build the text prompt --------------------------------------------
    // Append negative instructions inline; Gemini treats these as avoidance
    // guidance when phrased as "Avoid: …" at the end of the main prompt.
    let fullPrompt = prompt.trim();
    if (negativePrompt && negativePrompt.trim()) {
      fullPrompt += `. Avoid: ${negativePrompt.trim()}`;
    }

    // --- Build the contents array -----------------------------------------
    // Multi-part: every user image first (inline base64, never a URL), then
    // the text instruction. Gemini accepts several inlineData parts, which is
    // what multi-image styles rely on.
    const contents = [
      {
        role: "user",
        parts: [
          ...sources.map((src) => ({
            inlineData: {
              mimeType: src.mimeType || "image/jpeg",
              data: src.buffer.toString("base64"),
            },
          })),
          {
            text: fullPrompt,
          },
        ],
      },
    ];

    // --- Call the Gemini API ----------------------------------------------
    let response;
    try {
      response = await this.ai.models.generateContent({
        model: GENERATION_MODEL,
        contents,
        config: {
          // Request both TEXT and IMAGE so the model can caption + generate.
          // If the model only returns IMAGE, that's fine — we ignore text parts.
          responseModalities: ["TEXT", "IMAGE"],
        },
      });
    } catch (err) {
      throw new Error(
        `[GeminiProvider] Gemini API call failed: ${err.message || err}`
      );
    }

    // --- Extract the image part from the response ------------------------
    const parts = response?.candidates?.[0]?.content?.parts;
    if (!parts || parts.length === 0) {
      throw new Error(
        "[GeminiProvider] Gemini returned an empty response. " +
          "The model may not support image output for this prompt or API key tier."
      );
    }

    const imagePart = parts.find((p) => p.inlineData?.data);
    if (!imagePart) {
      // Surface any text explanation the model may have returned for debugging.
      const textPart = parts.find((p) => p.text);
      throw new Error(
        "[GeminiProvider] Gemini did not return an image in the response. " +
          (textPart ? `Model message: "${textPart.text}"` : "No text reason provided.")
      );
    }

    // --- Convert base64 result back to a Buffer --------------------------
    const resultBuffer = Buffer.from(imagePart.inlineData.data, "base64");
    if (resultBuffer.length === 0) {
      throw new Error("[GeminiProvider] Received an empty image buffer from Gemini.");
    }

    return resultBuffer;
  }
}

module.exports = GeminiProvider;
