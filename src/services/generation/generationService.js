"use strict";

/**
 * generationService — Orchestrates the full AI style generation pipeline.
 *
 * Flow:
 *   1. Fetch the style preset from PostgreSQL.
 *   2. Build the prompt payload.
 *   3. Select AI provider from .env.
 *   4. Generate image.
 *   5. Upload generated image to Supabase.
 *   6. Return public URL.
 */

const supabase = require("../../config/supabase");
const styleModel = require("../../models/styleModel");
const promptBuilder = require("../../utils/promptBuilder");

const GeminiProvider = require("./geminiProvider");
const FalProvider = require("./falProvider");

const { v4: uuid } = require("uuid");

/**
 * Returns the configured AI provider.
 */
function getProvider() {
  const provider = (process.env.IMAGE_PROVIDER || "gemini").toLowerCase();

  switch (provider) {
    case "fal":
      console.log("🟢 Using Fal Provider");
      return new FalProvider();

    case "gemini":
      console.log("🔵 Using Gemini Provider");
      return new GeminiProvider();

    default:
      throw new Error(`Unknown IMAGE_PROVIDER: ${provider}`);
  }
}

/**
 * Upload generated image to Supabase Storage.
 */
async function uploadToSupabase(buffer, mimetype, extension) {
  const filename = `${uuid()}.${extension}`;

  const { error } = await supabase.storage
    .from("style-images")
    .upload(filename, buffer, {
      contentType: mimetype,
      upsert: false,
    });

  if (error) {
    throw new Error(
      `[generationService] Supabase upload failed: ${error.message}`
    );
  }

  const { data } = supabase.storage
    .from("style-images")
    .getPublicUrl(filename);

  return data.publicUrl;
}

/**
 * Returns extension from MIME type.
 */
function extensionFromMime(mimeType) {
  const map = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
  };

  return map[mimeType] || "jpg";
}

/**
 * Main generation pipeline.
 */
async function generate(file, styleId) {
  // Load style
  const style = await styleModel.getStyleById(styleId);

  if (!style) {
    throw new Error("Style preset not found.");
  }

  if (!style.isEnabled) {
    throw new Error("Style is disabled.");
  }

  // Build prompt
  const promptData = promptBuilder.buildPrompt(style);

  // Choose provider
  const provider = getProvider();

  // Generate image
  const generatedBuffer = await provider.generateImage({
    imageBuffer: file.buffer,
    mimeType: file.mimetype,
    prompt: promptData.prompt,
    negativePrompt: promptData.negativePrompt,
  });

  // Output extension
  const extension = extensionFromMime(file.mimetype);

  // Upload to Supabase
  const imageUrl = await uploadToSupabase(
    generatedBuffer,
    file.mimetype,
    extension
  );

  return imageUrl;
}

module.exports = {
  generate,
};