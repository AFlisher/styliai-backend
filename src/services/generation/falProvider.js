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

      const result = await fal.subscribe(
        "fal-ai/flux/dev/image-to-image",
        {
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
      );

      //------------------------------------------
      // Validate response
      //------------------------------------------

      const images =
        result?.data?.images ||
        result?.images ||
        [];

      if (!images.length) {
        throw new Error("Fal returned no generated images.");
      }

      //------------------------------------------
      // Download image
      //------------------------------------------

      const generatedUrl = images[0].url;

      const response = await fetch(generatedUrl);

      if (!response.ok) {
        throw new Error(
          `Download failed (${response.status})`
        );
      }

      const arrayBuffer =
        await response.arrayBuffer();

      return Buffer.from(arrayBuffer);
    } catch (err) {
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