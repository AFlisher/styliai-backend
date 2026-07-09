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
    prompt,
    negativePrompt,
  }) {
    try {
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

      throw new Error(
        `[FalProvider Error] ${err.message}`
      );
    }
  }
}

module.exports = FalProvider;