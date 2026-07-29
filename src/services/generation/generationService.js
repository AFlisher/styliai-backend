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

const styleModel = require("../../models/styleModel");
const promptBuilder = require("../../utils/promptBuilder");
const imageStorageService = require("../imageStorageService");
const imageMetadataSanitizer = require("../../utils/imageMetadataSanitizer");

const GeminiProvider = require("./geminiProvider");
const FalProvider = require("./falProvider");

// Generated style-transfer output lives in the same bucket as admin-uploaded
// style images, unchanged from before the thumbnail system - only the
// original/thumbs path split inside it is new (see imageStorageService).
const STYLE_IMAGES_BUCKET = "style-images";

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
 * Upload the generated original image to Supabase Storage, plus its
 * browsing thumbnail (see imageStorageService.uploadOriginalWithThumbnail).
 */
async function uploadToSupabase(buffer, mimetype) {
  return imageStorageService.uploadOriginalWithThumbnail({
    buffer,
    mimeType: mimetype,
    bucket: STYLE_IMAGES_BUCKET,
  });
}

/**
 * Main generation pipeline.
 *
 * `fileOrFiles` is one Multer file or an array of them (multi-image styles).
 * The first image drives the output mime/extension; providers receive the
 * full set.
 */
async function generate(fileOrFiles, styleId, finalPrompt, abortSignal) {
  const files = Array.isArray(fileOrFiles) ? fileOrFiles : [fileOrFiles];
  const file = files[0];

  // Load style
  const style = await styleModel.getStyleById(styleId);

  if (!style) {
    throw new Error("Style preset not found.");
  }

  if (!style.isEnabled) {
    throw new Error("Style is disabled.");
  }

  // Build prompt. When the controller has already resolved the dynamic
  // template server-side (finalPrompt), use it verbatim; otherwise fall back
  // to the style's raw prompt (styles with no placeholders / legacy callers).
  const promptData = promptBuilder.buildPrompt(style);
  const resolvedPrompt = finalPrompt != null ? finalPrompt : promptData.prompt;

  // Choose provider
  const provider = getProvider();

  // SEC-8.3 - strip EXIF/XMP/IPTC before the user's photo leaves our
  // infrastructure. This has to happen server-side rather than in the app:
  // the client cannot be relied on (old installs keep sending what they
  // always sent), and under IMAGE_PROVIDER=fal the source image is uploaded
  // to fal's CDN under a public URL with retention we do not control and no
  // delete call on our side - so metadata that ships here is gone for good.
  //
  // Sequential rather than Promise.all: this is CPU-bound work on buffers up
  // to 10 MB each, and a multi-image style firing four decodes at once would
  // contend with every other in-flight generation on the same box.
  //
  // A failure throws, which the controller already treats as a failed
  // generation and refunds (generateController.js). Failing the generation is
  // the right outcome - the alternative is quietly forwarding the metadata.
  const sources = [];
  for (const f of files) {
    const { buffer } = await imageMetadataSanitizer.sanitizeImageBuffer(f.buffer);
    sources.push({ buffer, mimeType: f.mimetype });
  }

  // Generate image. `imageBuffer`/`mimeType` stay the first image so the
  // provider signature contract is unchanged; `images` carries the full set
  // for providers that support multiple source images.
  // SEC-7.2: the budget is owned here and threaded down, rather than each
  // provider inventing its own. `abortSignal` carries caller cancellation
  // (client disconnect) alongside it; the provider sees one combined signal.
  const generatedBuffer = await provider.generateImage({
    abortSignal,
    imageBuffer: sources[0].buffer,
    mimeType: sources[0].mimeType,
    images: sources,
    prompt: resolvedPrompt,
    negativePrompt: promptData.negativePrompt,
  });

  // Upload the original plus its browsing thumbnail.
  const { url: imageUrl, thumbnailUrl } = await uploadToSupabase(generatedBuffer, file.mimetype);
  return { imageUrl, thumbnailUrl };
}

module.exports = {
  generate,
};