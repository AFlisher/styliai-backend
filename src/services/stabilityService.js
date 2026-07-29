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
// SEC-7.2: the hard-coded 60s that used to live here is now the shared
// generation budget, so Stability, Gemini and fal cannot drift apart. The value
// is unchanged by default - this is a coordination change, not a retuning.
const { generationTimeouts } = require("../config/generationTimeouts");
const {
  withGenerationBudget,
  GenerationTimeoutError,
} = require("../utils/generationBudget");

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
    // SEC-7.1 Stage 1: 403 is Stability's content-moderation refusal. It was
    // grouped with the malformed-request statuses below, which made a policy
    // rejection indistinguishable from a bad payload.
    case 403:
      return "content_moderation";
    case 400:
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
 * @param {boolean} [params.persist=true] - When false the image is returned inline
 *   as a data URI and never written to storage. See the note below.
 * @returns {Promise<{ imageUrl: string, seed: string|undefined, finishReason: string|undefined }>}
 */
async function generateImage({ prompt, negativePrompt, aspectRatio, style, abortSignal, persist = true }) {
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

  let response;
  try {
    response = await withGenerationBudget(
      "provider",
      generationTimeouts.providerMs,
      abortSignal,
      (signal) =>
        fetch(STABILITY_ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: "image/*",
          },
          body: form,
          signal,
        })
    );
  } catch (err) {
    // Timeout keeps its existing kind so the controller's mapping is unchanged.
    if (err instanceof GenerationTimeoutError) {
      throw new StabilityApiError("timeout", err.message);
    }
    // Caller cancellation is neither a timeout nor a provider failure and is
    // rethrown untouched, so the controller can log it as its own outcome.
    if (err && err.isGenerationCancelled) {
      throw err;
    }
    throw new StabilityApiError(
      "network_error",
      `Failed to reach Stability AI: ${err.message}`
    );
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

  // SEC-8.1B-2 — a non-persisted image is returned inline and never stored.
  //
  // The admin prompt-test tool used this same call and kept its output: two
  // objects per click, written into `creations` with no row that could ever
  // reference them. They were orphans from birth (SEC-8.4 identified this as
  // the only recurring orphan source in the system, and the four objects swept
  // during SEC-8.1A were almost certainly its output), and they put admin test
  // renders in the bucket that is about to become private user content.
  //
  // Returning a data URI rather than a stored object removes the orphan source
  // and takes the preview out of the privacy migration entirely: the dashboard
  // renders it in an <img>, which needs no signed URL, no auth header and no
  // change on its side. Preview output is ephemeral test material - there is
  // nothing to keep.
  if (!persist) {
    return {
      imageUrl: `data:image/webp;base64,${buffer.toString("base64")}`,
      thumbnailUrl: null,
      seed: response.headers.get("seed") || undefined,
      finishReason: response.headers.get("finish-reason") || undefined,
    };
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
  // SEC-7.1: exported so the status -> kind mapping is directly testable.
  // Without this the 403 split is only reachable through a live HTTP call,
  // which is how it stayed untested long enough for a vacuity probe to notice.
  __testing: { errorKindForStatus },
};
