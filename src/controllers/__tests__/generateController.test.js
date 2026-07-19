// Explicit factory mocks (rather than jest.mock(path) automocking) so the
// real modules - which eagerly construct a Supabase client at import time -
// are never actually loaded during tests.
jest.mock("../../services/generation/generationService", () => ({
  generate: jest.fn(),
}));
jest.mock("../../services/wallet/walletService", () => ({
  deductBalance: jest.fn(),
  addBalance: jest.fn(),
}));
jest.mock("../../models/styleModel", () => ({
  getStyleById: jest.fn(),
}));
jest.mock("../../models/creationsModel", () => ({
  addCreation: jest.fn(),
}));

const generationService = require("../../services/generation/generationService");
const walletService = require("../../services/wallet/walletService");
const styleModel = require("../../models/styleModel");
const creationsModel = require("../../models/creationsModel");
const { generateImage } = require("../generateController");

function makeReqRes({ file = { buffer: Buffer.from("x") }, styleId = "style-1" } = {}) {
  const req = {
    body: { styleId },
    file,
    user: { id: "user-1" },
  };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const next = jest.fn();
  return { req, res, next };
}

const ENABLED_STYLE = { id: "style-1", name: "Test Style", creditCost: 2, isEnabled: true };

describe("generateController.generateImage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    styleModel.getStyleById.mockResolvedValue(ENABLED_STYLE);
    walletService.deductBalance.mockResolvedValue(8);
    walletService.addBalance.mockResolvedValue(10);
    generationService.generate.mockResolvedValue({
      imageUrl: "https://example.com/generated.png",
      thumbnailUrl: "https://example.com/generated-thumb.webp",
    });
    creationsModel.addCreation.mockResolvedValue({ id: "creation-1" });
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    console.error.mockRestore();
  });

  it("returns 200 with the generated URL on success, charging exactly once", async () => {
    const { req, res, next } = makeReqRes();

    await generateImage(req, res, next);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      generatedImageUrl: "https://example.com/generated.png",
      thumbnailUrl: "https://example.com/generated-thumb.webp",
    });
    expect(walletService.deductBalance).toHaveBeenCalledTimes(1);
    expect(walletService.deductBalance).toHaveBeenCalledWith("user-1", 2, "generation", "Image generated");
    expect(generationService.generate).toHaveBeenCalledTimes(1);
    expect(walletService.addBalance).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(creationsModel.addCreation).toHaveBeenCalledWith({
      userId: "user-1",
      styleId: "style-1",
      styleName: "Test Style",
      imageUrl: "https://example.com/generated.png",
      thumbnailUrl: "https://example.com/generated-thumb.webp",
    });
  });

  it("still returns 200 with the generated URL even if recording creation history fails", async () => {
    creationsModel.addCreation.mockRejectedValue(new Error("db hiccup"));
    const { req, res, next } = makeReqRes();

    await generateImage(req, res, next);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      generatedImageUrl: "https://example.com/generated.png",
      thumbnailUrl: "https://example.com/generated-thumb.webp",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects with VALIDATION_ERROR when no file is provided, before any charge", async () => {
    const { req, res, next } = makeReqRes({ file: null });

    await generateImage(req, res, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ code: "VALIDATION_ERROR", statusCode: 400 })
    );
    expect(walletService.deductBalance).not.toHaveBeenCalled();
  });

  it("rejects with VALIDATION_ERROR when styleId is missing", async () => {
    const { req, res, next } = makeReqRes({ styleId: null });

    await generateImage(req, res, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ code: "VALIDATION_ERROR", statusCode: 400 })
    );
  });

  it("rejects with NOT_FOUND when the style doesn't exist", async () => {
    styleModel.getStyleById.mockResolvedValue(null);
    const { req, res, next } = makeReqRes();

    await generateImage(req, res, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ code: "NOT_FOUND", statusCode: 404 })
    );
    expect(walletService.deductBalance).not.toHaveBeenCalled();
  });

  it("rejects with VALIDATION_ERROR when the style is disabled", async () => {
    styleModel.getStyleById.mockResolvedValue({ ...ENABLED_STYLE, isEnabled: false });
    const { req, res, next } = makeReqRes();

    await generateImage(req, res, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ code: "VALIDATION_ERROR", statusCode: 400 })
    );
    expect(walletService.deductBalance).not.toHaveBeenCalled();
  });

  it("maps a wallet 'Insufficient balance' error to INSUFFICIENT_BALANCE/403", async () => {
    walletService.deductBalance.mockRejectedValue(new Error("Insufficient balance"));
    const { req, res, next } = makeReqRes();

    await generateImage(req, res, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ code: "INSUFFICIENT_BALANCE", statusCode: 403 })
    );
    expect(generationService.generate).not.toHaveBeenCalled();
  });

  it("refunds and maps a provider lockout (status 403) to PROVIDER_UNAVAILABLE/503", async () => {
    const providerErr = new Error("forbidden");
    providerErr.status = 403;
    generationService.generate.mockRejectedValue(providerErr);
    const { req, res, next } = makeReqRes();

    await generateImage(req, res, next);

    expect(walletService.addBalance).toHaveBeenCalledWith(
      "user-1",
      2,
      "refund",
      "Refund for failed generation"
    );
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ code: "PROVIDER_UNAVAILABLE", statusCode: 503 })
    );
  });

  it("refunds and maps an unrecognized generation failure to INTERNAL_ERROR/500", async () => {
    generationService.generate.mockRejectedValue(new Error("some unexpected provider crash"));
    const { req, res, next } = makeReqRes();

    await generateImage(req, res, next);

    expect(walletService.addBalance).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "INTERNAL_ERROR",
        statusCode: 500,
        message: "some unexpected provider crash",
      })
    );
  });

  it("logs a [FINANCIAL INCONSISTENCY] error and still responds if the refund itself fails", async () => {
    generationService.generate.mockRejectedValue(new Error("provider crash"));
    walletService.addBalance.mockRejectedValue(new Error("refund db error"));
    const { req, res, next } = makeReqRes();

    await generateImage(req, res, next);

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("[FINANCIAL INCONSISTENCY]"),
      expect.objectContaining({
        userId: "user-1",
        amount: 2,
        originalError: "provider crash",
        refundError: "refund db error",
      })
    );
    // The refund failure itself becomes the propagated error.
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ code: "INTERNAL_ERROR", statusCode: 500, message: "refund db error" })
    );
  });
});
