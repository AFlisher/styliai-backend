const { withGenerationBudget } = require("../../utils/generationBudget");
const { generationTimeouts } = require("../../config/generationTimeouts");
"use strict";

/**
 * FalProvider - Image-to-Image generation using Fal AI.
 * Compatible with @fal-ai/client v1.10.x
 */

const { fal } = require("@fal-ai/client");

// Configure SDK
fal.config({
  credentials: process.env.FAL_API_KEY,
});

class FalProvider {
  constructor() {
    if (!process.env.FAL_API_KEY) {
      throw new Error("FAL_API_KEY is missing from .env");
    }
  }

  /**
   * Generate styled image.
   */
  async generateImage({
    imageBuffer,
    mimeType,
    images,
    prompt,
    negativePrompt,
    abortSignal,
  }) {
    try {
      // flux/dev/image-to-image takes exactly one source image. Refusing
      // (rather than silently dropping extras) surfaces a clear error and
      // triggers the controller's refund path; multi-image styles need
      // IMAGE_PROVIDER=gemini.
      if (images && images.length > 1) {
        throw new Error(
          "The configured image provider (fal flux image-to-image) supports a single source image. Use the Gemini provider for multi-image styles."
        );
      }

      if (!Buffer.isBuffer(imageBuffer)) {
        throw new Error("imageBuffer must be a Buffer.");
      }

      if (!prompt?.trim()) {
        throw new Error("Prompt is required.");
      }

      //------------------------------------------
      // Upload source image
      //------------------------------------------

      const blob = new Blob(
        [imageBuffer],
        {
          type: mimeType || "image/jpeg",
        }
      );

      const imageUrl = await fal.storage.upload(blob);

      //------------------------------------------
      // Call Fal Model
      //------------------------------------------

      // SEC-7.2: fal.subscribe polls a queued job and was previously unbounded -
      // the longest-running of the three provider calls and the only one with a
      // second unbounded network op after it.
      const result = await withGenerationBudget(
        "provider",
        generationTimeouts.providerMs,
        abortSignal,
        (signal) => fal.subscribe(
        "fal-ai/flux/dev/image-to-image",
        {
          abortSignal: signal,
          input: {
            image_url: imageUrl,

            prompt,

            negative_prompt: negativePrompt || "",

            strength: 0.35,

            image_size: "square_hd",

            guidance_scale: 3.5,

            num_inference_steps: 28,

            sync_mode: true,
          },
        }
        )
      );

      //------------------------------------------
      // Validate response
      //------------------------------------------

      // Named resultImages, not images: the method already destructures an
      // `images` parameter, and a block-scoped `const images` here put that
      // parameter in a temporal dead zone - so the guard near the top of this
      // try block threw ReferenceError on every call. Pre-existing and
      // unrelated to SEC-7.2; found because the new timeout tests were the
      // first to execute this provider at all. fal is not the default
      // (IMAGE_PROVIDER defaults to gemini), which is why it went unnoticed.
      const resultImages =
        result?.data?.images ||
        result?.images ||
        [];

      if (!resultImages.length) {
        throw new Error("Fal returned no generated images.");
      }

      //------------------------------------------
      // Download image
      //------------------------------------------

      const generatedUrl = resultImages[0].url;

      // A plain CDN download, given its own shorter budget: it has no business
      // inheriting a generation-sized allowance, and unbounded it could hold
      // the request and its buffered uploads on a stalled connection alone.
      const response = await withGenerationBudget(
        "download",
        generationTimeouts.downloadMs,
        abortSignal,
        (signal) => fetch(generatedUrl, { signal })
      );

      if (!response.ok) {
        throw new Error(
          `Download failed (${response.status})`
        );
      }

      const arrayBuffer =
        await response.arrayBuffer();

      return Buffer.from(arrayBuffer);
    } catch (err) {
      // SEC-7.2: a timeout or a caller cancellation is neither a provider
      // failure nor something to dump a stack trace for - it passes through
      // untouched so the controller can tell all three apart.
      if (err && (err.isGenerationTimeout || err.isGenerationCancelled)) throw err;

      console.log("========== FAL ERROR ==========");
      console.dir(err, { depth: null });

      if (err.response) {
        console.log(err.response);
      }

      if (err.body) {
        console.log(err.body);
      }

      console.log("===============================");

      const customErr = new Error(`[FalProvider Error] ${err.message}`);
      customErr.status = err.status || err.statusCode || err.response?.status || err.body?.status;
      customErr.body = err.body;
      customErr.response = err.response;
      throw customErr;
    }
  }
}

module.exports = FalProvider;