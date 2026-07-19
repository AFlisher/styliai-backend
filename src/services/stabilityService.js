"use strict";

/**
 * stabilityService - Talks to the Stability AI REST API
 * (https://api.stability.ai/v2beta/stable-image/generate/core) and uploads
 * the resulting image to Supabase Storage, returning a public URL.
 *
 * Deliberately self-contained: does not import or depend on
 * generationService/falProvider/geminiProvider or autoTagService - this is
 * a separate integration from both the existing /api/generate pipeline and
 * the AI tagging service, per the isolation requirement it was built under.
 *
 * The API key is read only from process.env.STABILITY_API_KEY at call time
 * (never hardcoded, never logged, never returned in any response).
 */

const { v4: uuid } = require("uuid");
const imageStorageService = require("./imageStorageService");

const STABILITY_ENDPOINT = "https://api.stability.ai/v2beta/stable-image/generate/core";
const REQUEST_TIMEOUT_MS = 60000;

/**
 * Structured error thrown by generateImage(). `kind` is a stable machine
 * label the controller maps to an ErrorCodes entry + HTTP status - keeps
 * that mapping in one place (the controller) instead of duplicated here.
 */
class StabilityApiError extends Error {
  constructor(kind, message, details) {
    super(message);
    this.kind = kind;
    this.details = details;
  }
}

function getApiKey() {
  const apiKey = process.env.STABILITY_API_KEY;
  if (!apiKey) {
    throw new StabilityApiError(
      "missing_api_key",
      "STABILITY_API_KEY is not configured on the server."
    );
  }
  return apiKey;
}

/**
 * Maps a Stability HTTP response status to a StabilityApiError kind.
 * See https://platform.stability.ai/docs/api-reference for the status
 * codes this API actually returns.
 */
function errorKindForStatus(status) {
  switch (status) {
    case 401:
      return "invalid_api_key";
    case 402:
      return "insufficient_credits";
    case 429:
      return "rate_limited";
    case 400:
    case 403:
    case 413:
    case 422:
      return "bad_request";
    default:
      return "provider_error";
  }
}

// User-generated Stability output lives in its own "creations" bucket,
// deliberately separate from "style-images" (which holds application/style
// assets) - keeps cleanup, permissions, and future scaling decisions for
// user content independent of app assets.
const CREATIONS_BUCKET = "creations";

async function uploadToSupabase(buffer, outputFormat) {
  const contentType = `image/${outputFormat}`;

  try {
    return await imageStorageService.uploadOriginalWithThumbnail({
      buffer,
      mimeType: contentType,
      bucket: CREATIONS_BUCKET,
      baseName: `stability-${uuid()}`,
    });
  } catch (err) {
    throw new StabilityApiError(
      "upload_failed",
      `Failed to store the generated image: ${err.message}`
    );
  }
}

/**
 * Generates an image via Stability AI and returns its public URL.
 *
 * @param {Object} params
 * @param {string} params.prompt - Required.
 * @param {string} [params.negativePrompt]
 * @param {string} [params.aspectRatio] - e.g. "1:1", "16:9", "9:16".
 * @param {string} [params.style] - Stability's style_preset (e.g. "photographic", "anime").
 * @returns {Promise<{ imageUrl: string, seed: string|undefined, finishReason: string|undefined }>}
 */
async function generateImage({ prompt, negativePrompt, aspectRatio, style }) {
  const apiKey = getApiKey();

  if (!prompt || !prompt.trim()) {
    throw new StabilityApiError("validation_error", "prompt is required.");
  }

  const form = new FormData();
  form.append("prompt", prompt);
  if (negativePrompt) form.append("negative_prompt", negativePrompt);
  if (aspectRatio) form.append("aspect_ratio", aspectRatio);
  if (style) form.append("style_preset", style);
  form.append("output_format", "webp");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(STABILITY_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "image/*",
      },
      body: form,
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new StabilityApiError(
        "timeout",
        `Stability AI request timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`
      );
    }
    throw new StabilityApiError(
      "network_error",
      `Failed to reach Stability AI: ${err.message}`
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    // Error responses are JSON regardless of the Accept header we sent.
    let details;
    try {
      details = await response.json();
    } catch {
      details = await response.text().catch(() => undefined);
    }

    const kind = errorKindForStatus(response.status);
    const message =
      (details && (details.name || details.errors?.join?.(", "))) ||
      `Stability AI returned ${response.status}.`;

    throw new StabilityApiError(kind, message, { status: response.status, details });
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  if (buffer.length === 0) {
    throw new StabilityApiError("provider_error", "Stability AI returned an empty image.");
  }

  const { url: imageUrl, thumbnailUrl } = await uploadToSupabase(buffer, "webp");

  return {
    imageUrl,
    thumbnailUrl,
    seed: response.headers.get("seed") || undefined,
    finishReason: response.headers.get("finish-reason") || undefined,
  };
}

module.exports = {
  generateImage,
  StabilityApiError,
};
