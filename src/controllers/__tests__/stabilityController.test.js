// Explicit factory mocks (rather than jest.mock(path) automocking) so the
// real modules - which eagerly construct a Supabase/DB client at import time
// - are never actually loaded during tests.
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
jest.mock("../../services/wallet/walletService", () => ({
  deductBalance: jest.fn(),
  addBalance: jest.fn(),
}));
jest.mock("../../models/creationsModel", () => ({
  addCreation: jest.fn(),
}));

const stabilityService = require("../../services/stabilityService");
const walletService = require("../../services/wallet/walletService");
const creationsModel = require("../../models/creationsModel");
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
    walletService.deductBalance.mockResolvedValue(9);
    walletService.addBalance.mockResolvedValue(10);
    stabilityService.generateImage.mockResolvedValue({
      imageUrl: "https://example.com/generated.webp",
    });
    creationsModel.addCreation.mockResolvedValue({ id: "creation-1" });
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    console.error.mockRestore();
  });

  it("returns 200 with the generated image URL on success, charging exactly once", async () => {
    const { req, res, next } = makeReqRes();

    await generateImage(req, res, next);

    expect(walletService.deductBalance).toHaveBeenCalledTimes(1);
    expect(walletService.deductBalance).toHaveBeenCalledWith(
      "user-1",
      1,
      "generation",
      "AI image generated (Stability)"
    );
    expect(stabilityService.generateImage).toHaveBeenCalledWith({
      prompt: "a cat astronaut",
      negativePrompt: undefined,
      aspectRatio: undefined,
      style: undefined,
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      imageUrl: "https://example.com/generated.webp",
    });
    expect(walletService.addBalance).not.toHaveBeenCalled();
    expect(creationsModel.addCreation).toHaveBeenCalledWith({
      userId: "user-1",
      styleId: null,
      styleName: "Stability AI Text-to-Image",
      imageUrl: "https://example.com/generated.webp",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("still returns 200 with the generated URL even if recording creation history fails", async () => {
    creationsModel.addCreation.mockRejectedValue(new Error("db hiccup"));
    const { req, res, next } = makeReqRes();

    await generateImage(req, res, next);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      imageUrl: "https://example.com/generated.webp",
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

  it("rejects with VALIDATION_ERROR when prompt is missing, before any charge", async () => {
    const { req, res, next } = makeReqRes({ prompt: null });

    await generateImage(req, res, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ code: "VALIDATION_ERROR", statusCode: 400 })
    );
    expect(walletService.deductBalance).not.toHaveBeenCalled();
    expect(stabilityService.generateImage).not.toHaveBeenCalled();
  });

  it("rejects with VALIDATION_ERROR when prompt is blank", async () => {
    const { req, res, next } = makeReqRes({ prompt: "   " });

    await generateImage(req, res, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ code: "VALIDATION_ERROR", statusCode: 400 })
    );
    expect(walletService.deductBalance).not.toHaveBeenCalled();
    expect(stabilityService.generateImage).not.toHaveBeenCalled();
  });

  it("maps insufficient wallet balance to INSUFFICIENT_BALANCE/403, without calling Stability", async () => {
    walletService.deductBalance.mockRejectedValue(new Error("Insufficient balance"));
    const { req, res, next } = makeReqRes();

    await generateImage(req, res, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ code: "INSUFFICIENT_BALANCE", statusCode: 403 })
    );
    expect(stabilityService.generateImage).not.toHaveBeenCalled();
  });

  it("refunds and maps invalid_api_key to PROVIDER_UNAVAILABLE/503", async () => {
    stabilityService.generateImage.mockRejectedValue(
      new stabilityService.StabilityApiError("invalid_api_key", "bad key")
    );
    const { req, res, next } = makeReqRes();

    await generateImage(req, res, next);

    expect(walletService.addBalance).toHaveBeenCalledWith(
      "user-1",
      1,
      "refund",
      "Refund for failed Stability generation"
    );
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ code: "PROVIDER_UNAVAILABLE", statusCode: 503 })
    );
    expect(creationsModel.addCreation).not.toHaveBeenCalled();
  });

  it("refunds and maps insufficient_credits to PROVIDER_UNAVAILABLE/503", async () => {
    stabilityService.generateImage.mockRejectedValue(
      new stabilityService.StabilityApiError("insufficient_credits", "no credits")
    );
    const { req, res, next } = makeReqRes();

    await generateImage(req, res, next);

    expect(walletService.addBalance).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ code: "PROVIDER_UNAVAILABLE", statusCode: 503 })
    );
  });

  it("refunds and maps rate_limited to RATE_LIMITED/429", async () => {
    stabilityService.generateImage.mockRejectedValue(
      new stabilityService.StabilityApiError("rate_limited", "too many requests")
    );
    const { req, res, next } = makeReqRes();

    await generateImage(req, res, next);

    expect(walletService.addBalance).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ code: "RATE_LIMITED", statusCode: 429 })
    );
  });

  it("refunds and maps timeout to PROVIDER_UNAVAILABLE/503", async () => {
    stabilityService.generateImage.mockRejectedValue(
      new stabilityService.StabilityApiError("timeout", "timed out")
    );
    const { req, res, next } = makeReqRes();

    await generateImage(req, res, next);

    expect(walletService.addBalance).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ code: "PROVIDER_UNAVAILABLE", statusCode: 503 })
    );
  });

  it("refunds and maps an unrecognized provider error kind to PROVIDER_UNAVAILABLE/503", async () => {
    stabilityService.generateImage.mockRejectedValue(
      new stabilityService.StabilityApiError("provider_error", "upstream 500")
    );
    const { req, res, next } = makeReqRes();

    await generateImage(req, res, next);

    expect(walletService.addBalance).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ code: "PROVIDER_UNAVAILABLE", statusCode: 503 })
    );
  });

  it("refunds and maps an unexpected non-Stability error to INTERNAL_ERROR/500", async () => {
    stabilityService.generateImage.mockRejectedValue(new Error("unexpected crash"));
    const { req, res, next } = makeReqRes();

    await generateImage(req, res, next);

    expect(walletService.addBalance).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "INTERNAL_ERROR",
        statusCode: 500,
        message: "unexpected crash",
      })
    );
  });

  it("logs a [FINANCIAL INCONSISTENCY] error and still responds if the refund itself fails", async () => {
    stabilityService.generateImage.mockRejectedValue(new Error("provider crash"));
    walletService.addBalance.mockRejectedValue(new Error("refund db error"));
    const { req, res, next } = makeReqRes();

    await generateImage(req, res, next);

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("[FINANCIAL INCONSISTENCY]"),
      expect.objectContaining({
        userId: "user-1",
        amount: 1,
        originalError: "provider crash",
        refundError: "refund db error",
      })
    );
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ code: "INTERNAL_ERROR", statusCode: 500, message: "refund db error" })
    );
  });
});
