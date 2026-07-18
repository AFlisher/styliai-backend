// Explicit factory mock (rather than jest.mock(path) automocking) so the
// real module - which eagerly imports the Supabase client at import time -
// is never actually loaded during tests.
jest.mock("../../services/stabilityService", () => {
  class StabilityApiError extends Error {
    constructor(kind, message, details) {
      super(message);
      this.kind = kind;
      this.details = details;
    }
  }
  return {
    generateImage: jest.fn(),
    StabilityApiError,
  };
});

const stabilityService = require("../../services/stabilityService");
const { generateImage } = require("../stabilityController");

function makeReqRes({ prompt = "a cat astronaut", negativePrompt, aspectRatio, style } = {}) {
  const req = {
    body: { prompt, negativePrompt, aspectRatio, style },
    user: { id: "user-1" },
  };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const next = jest.fn();
  return { req, res, next };
}

describe("stabilityController.generateImage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    stabilityService.generateImage.mockResolvedValue({
      imageUrl: "https://example.com/generated.png",
    });
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    console.error.mockRestore();
  });

  it("returns 200 with the generated image URL on success", async () => {
    const { req, res, next } = makeReqRes();

    await generateImage(req, res, next);

    expect(stabilityService.generateImage).toHaveBeenCalledWith({
      prompt: "a cat astronaut",
      negativePrompt: undefined,
      aspectRatio: undefined,
      style: undefined,
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      imageUrl: "https://example.com/generated.png",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("passes through optional fields when provided", async () => {
    const { req, res, next } = makeReqRes({
      negativePrompt: "blurry",
      aspectRatio: "16:9",
      style: "photographic",
    });

    await generateImage(req, res, next);

    expect(stabilityService.generateImage).toHaveBeenCalledWith({
      prompt: "a cat astronaut",
      negativePrompt: "blurry",
      aspectRatio: "16:9",
      style: "photographic",
    });
  });

  it("rejects with VALIDATION_ERROR when prompt is missing, without calling the service", async () => {
    const { req, res, next } = makeReqRes({ prompt: null });

    await generateImage(req, res, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ code: "VALIDATION_ERROR", statusCode: 400 })
    );
    expect(stabilityService.generateImage).not.toHaveBeenCalled();
  });

  it("rejects with VALIDATION_ERROR when prompt is blank", async () => {
    const { req, res, next } = makeReqRes({ prompt: "   " });

    await generateImage(req, res, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ code: "VALIDATION_ERROR", statusCode: 400 })
    );
    expect(stabilityService.generateImage).not.toHaveBeenCalled();
  });

  it("maps invalid_api_key to PROVIDER_UNAVAILABLE/503", async () => {
    stabilityService.generateImage.mockRejectedValue(
      new stabilityService.StabilityApiError("invalid_api_key", "bad key")
    );
    const { req, res, next } = makeReqRes();

    await generateImage(req, res, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ code: "PROVIDER_UNAVAILABLE", statusCode: 503 })
    );
  });

  it("maps insufficient_credits to PROVIDER_UNAVAILABLE/503", async () => {
    stabilityService.generateImage.mockRejectedValue(
      new stabilityService.StabilityApiError("insufficient_credits", "no credits")
    );
    const { req, res, next } = makeReqRes();

    await generateImage(req, res, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ code: "PROVIDER_UNAVAILABLE", statusCode: 503 })
    );
  });

  it("maps rate_limited to RATE_LIMITED/429", async () => {
    stabilityService.generateImage.mockRejectedValue(
      new stabilityService.StabilityApiError("rate_limited", "too many requests")
    );
    const { req, res, next } = makeReqRes();

    await generateImage(req, res, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ code: "RATE_LIMITED", statusCode: 429 })
    );
  });

  it("maps timeout to PROVIDER_UNAVAILABLE/503", async () => {
    stabilityService.generateImage.mockRejectedValue(
      new stabilityService.StabilityApiError("timeout", "timed out")
    );
    const { req, res, next } = makeReqRes();

    await generateImage(req, res, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ code: "PROVIDER_UNAVAILABLE", statusCode: 503 })
    );
  });

  it("maps an unrecognized provider error kind to PROVIDER_UNAVAILABLE/503", async () => {
    stabilityService.generateImage.mockRejectedValue(
      new stabilityService.StabilityApiError("provider_error", "upstream 500")
    );
    const { req, res, next } = makeReqRes();

    await generateImage(req, res, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ code: "PROVIDER_UNAVAILABLE", statusCode: 503 })
    );
  });

  it("maps an unexpected non-Stability error to INTERNAL_ERROR/500", async () => {
    stabilityService.generateImage.mockRejectedValue(new Error("unexpected crash"));
    const { req, res, next } = makeReqRes();

    await generateImage(req, res, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "INTERNAL_ERROR",
        statusCode: 500,
        message: "unexpected crash",
      })
    );
  });
});
