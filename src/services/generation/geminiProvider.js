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

const { ContentModerationError } = require("../../utils/contentModeration");
const { GoogleGenAI } = require("@google/genai");

/**
 * The Gemini model used for image editing (multimodal input → image output).
 * gemini-2.0-flash-preview-image-generation supports image output modality
 * and accepts inline image input via inlineData parts.
 */
const GENERATION_MODEL =
    process.env.GEMINI_MODEL || "gemini-2.5-flash-image";
    
// SEC-7.1 Stage 2. BLOCK_MEDIUM_AND_ABOVE across every category Gemini exposes.
const SAFETY_THRESHOLD = "BLOCK_MEDIUM_AND_ABOVE";
const SAFETY_SETTINGS = Object.freeze([
  { category: "HARM_CATEGORY_HARASSMENT", threshold: SAFETY_THRESHOLD },
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: SAFETY_THRESHOLD },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: SAFETY_THRESHOLD },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: SAFETY_THRESHOLD },
]);

// finishReason / blockReason values that mean "refused on content grounds"
// rather than "something broke". Anything not listed here stays a provider
// error, because guessing a refusal from a generic failure is how a Gemini
// outage would start being reported to users as a policy violation.
const MODERATION_FINISH_REASONS = new Set([
  "SAFETY",
  "PROHIBITED_CONTENT",
  "IMAGE_SAFETY",
  "BLOCKLIST",
  "SPII",
]);

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
          // SEC-7.1 Stage 2: declare the safety posture rather than inherit it.
          // Relying on provider defaults means the app's content policy can
          // change without a commit, a review, or anyone noticing. Written as
          // plain strings rather than SDK enums so an SDK upgrade cannot
          // silently drop a category.
          //
          // BLOCK_NONE is deliberately absent and must stay that way: this app
          // takes user-uploaded photographs of people, so loosening any of
          // these is a policy decision with legal weight, not a tuning knob.
          safetySettings: SAFETY_SETTINGS,
        },
      });
    } catch (err) {
      throw new Error(
        `[GeminiProvider] Gemini API call failed: ${err.message || err}`
      );
    }

    // --- SEC-7.1 Stage 1: read the moderation signals ---------------------
    // Gemini reports a refusal in one of two places depending on whether it
    // rejected the input or what it produced. Neither was being read, so both
    // fell through to the "empty response" branch below and were reported as
    // provider failures.
    const blockReason = response?.promptFeedback?.blockReason;
    if (blockReason) {
      throw new ContentModerationError(
        "gemini",
        "prompt",
        safetyCategoriesFrom(response?.promptFeedback?.safetyRatings),
        String(blockReason)
      );
    }

    const finishReason = response?.candidates?.[0]?.finishReason;
    if (finishReason && MODERATION_FINISH_REASONS.has(String(finishReason))) {
      throw new ContentModerationError(
        "gemini",
        "output",
        safetyCategoriesFrom(response?.candidates?.[0]?.safetyRatings),
        String(finishReason)
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

/**
 * Pulls the categories that actually tripped, so the log says which policy was
 * hit without echoing the content that hit it.
 */
function safetyCategoriesFrom(ratings) {
  if (!Array.isArray(ratings)) return [];
  return ratings
    .filter((r) => r && (r.blocked === true || (r.probability && r.probability !== "NEGLIGIBLE")))
    .map((r) => String(r.category))
    .filter(Boolean);
}

module.exports = GeminiProvider;
