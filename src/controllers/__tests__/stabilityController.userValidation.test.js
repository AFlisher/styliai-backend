jest.mock("../../services/stabilityService", () => ({
  generateImage: jest.fn(),
  StabilityApiError: class StabilityApiError extends Error {},
}));
jest.mock("../../services/wallet/walletService", () => ({
  deductBalance: jest.fn(),
  addBalance: jest.fn(),
}));
jest.mock("../../models/creationsModel", () => ({ addCreation: jest.fn() }));
jest.mock("../../models/styleModel", () => ({ getStyleById: jest.fn() }));

const stabilityService = require("../../services/stabilityService");
const walletService = require("../../services/wallet/walletService");
const styleModel = require("../../models/styleModel");
const controller = require("../stabilityController");

function makeReqRes(body = {}) {
  const req = {
    body,
    user: { id: "u-1" },
    method: "POST",
    baseUrl: "/api/ai",
    path: "/generate",
    protocol: "https",
    get: () => "api.styli.test",
  };
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
  };
  const next = jest.fn();
  return { req, res, next };
}

beforeEach(() => jest.clearAllMocks());

/**
 * SEC-9.2 — the user-facing path is now bounded by the SAME validator that
 * already guarded the admin preview (written for SEC-15.8).
 *
 * ORDER is the property under test as much as the bounds themselves.
 * Validation that runs after the wallet deduction turns a rejected request
 * into a charge-and-refund pair; validation that runs after the provider call
 * is not validation at all.
 */
describe("SEC-9.2 — POST /api/ai/generate bounds client input before charging", () => {
  it("rejects an over-long prompt with 400 and never charges or calls the provider", async () => {
    const { req, res, next } = makeReqRes({
      prompt: "x".repeat(controller.MAX_PROMPT_LENGTH + 1),
    });

    await controller.generateImage(req, res, next);

    expect(next.mock.calls[0][0].statusCode).toBe(400);
    expect(walletService.deductBalance).not.toHaveBeenCalled();
    expect(stabilityService.generateImage).not.toHaveBeenCalled();
  });

  it("rejects an over-long negativePrompt before charging", async () => {
    const { req, res, next } = makeReqRes({
      prompt: "ok",
      negativePrompt: "x".repeat(controller.MAX_NEGATIVE_PROMPT_LENGTH + 1),
    });

    await controller.generateImage(req, res, next);

    expect(next.mock.calls[0][0].statusCode).toBe(400);
    expect(walletService.deductBalance).not.toHaveBeenCalled();
  });

  it("rejects an unsupported aspectRatio before charging", async () => {
    const { req, res, next } = makeReqRes({ prompt: "ok", aspectRatio: "999:1" });

    await controller.generateImage(req, res, next);

    expect(next.mock.calls[0][0].statusCode).toBe(400);
    expect(walletService.deductBalance).not.toHaveBeenCalled();
    expect(stabilityService.generateImage).not.toHaveBeenCalled();
  });

  it("rejects an unsupported style preset before charging", async () => {
    const { req, res, next } = makeReqRes({ prompt: "ok", style: "not-a-preset" });
    await controller.generateImage(req, res, next);
    expect(next.mock.calls[0][0].statusCode).toBe(400);
    expect(walletService.deductBalance).not.toHaveBeenCalled();
  });

  it("rejects a non-string negativePrompt", async () => {
    const { req, res, next } = makeReqRes({ prompt: "ok", negativePrompt: 42 });
    await controller.generateImage(req, res, next);
    expect(next.mock.calls[0][0].statusCode).toBe(400);
  });

  it("accepts every aspect ratio the provider supports", async () => {
    for (const ratio of controller.ALLOWED_ASPECT_RATIOS) {
      jest.clearAllMocks();
      walletService.deductBalance.mockResolvedValue(undefined);
      stabilityService.generateImage.mockResolvedValue({
        imageUrl: "https://x/i.webp",
        thumbnailUrl: null,
      });

      const { req, res, next } = makeReqRes({ prompt: "ok", aspectRatio: ratio });
      await controller.generateImage(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(stabilityService.generateImage).toHaveBeenCalled();
    }
  });
});

describe("SEC-9.2 — the styleId path still works", () => {
  it("accepts a request with no prompt when a styleId resolves one", async () => {
    styleModel.getStyleById.mockResolvedValue({
      id: "s-1",
      name: "Style",
      prompt: "a curated prompt",
      negativePrompt: null,
    });
    walletService.deductBalance.mockResolvedValue(undefined);
    stabilityService.generateImage.mockResolvedValue({
      imageUrl: "https://x/i.webp",
      thumbnailUrl: null,
    });

    const { req, res, next } = makeReqRes({ styleId: "s-1" });
    await controller.generateImage(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(stabilityService.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "a curated prompt" })
    );
  });

  // A style prompt is OUR data. Applying a user-input length cap to it would
  // turn an operator's over-long catalog entry into a 400 blaming the user.
  it("does not apply the user-input length cap to a server-resolved style prompt", async () => {
    styleModel.getStyleById.mockResolvedValue({
      id: "s-1",
      name: "Style",
      prompt: "x".repeat(controller.MAX_PROMPT_LENGTH + 500),
      negativePrompt: null,
    });
    walletService.deductBalance.mockResolvedValue(undefined);
    stabilityService.generateImage.mockResolvedValue({
      imageUrl: "https://x/i.webp",
      thumbnailUrl: null,
    });

    const { req, res, next } = makeReqRes({ styleId: "s-1" });
    await controller.generateImage(req, res, next);

    expect(next).not.toHaveBeenCalled();
  });

  it("still rejects when neither a usable prompt nor a resolvable style exists", async () => {
    styleModel.getStyleById.mockResolvedValue(null);
    const { req, res, next } = makeReqRes({ styleId: "missing" });

    await controller.generateImage(req, res, next);

    expect(next.mock.calls[0][0].statusCode).toBe(400);
    expect(walletService.deductBalance).not.toHaveBeenCalled();
  });

  it("rejects a present-but-empty prompt rather than falling through to style resolution", async () => {
    const { req, res, next } = makeReqRes({ prompt: "   " });
    await controller.generateImage(req, res, next);
    expect(next.mock.calls[0][0].statusCode).toBe(400);
  });
});

describe("SEC-9.2 — the admin preview keeps its own contract", () => {
  it("still requires a prompt (no styleId fallback exists there)", () => {
    expect(() => controller.validatePreviewInput({})).toThrow(
      expect.objectContaining({ statusCode: 400 })
    );
  });

  it("shares the same bounds as the user path", () => {
    expect(() =>
      controller.validatePreviewInput({ prompt: "x".repeat(controller.MAX_PROMPT_LENGTH + 1) })
    ).toThrow(expect.objectContaining({ statusCode: 400 }));
  });

  // VACUITY: the validator must accept valid input, or every rejection test
  // above would pass for the wrong reason.
  it("VACUITY: accepts a well-formed payload", () => {
    expect(() =>
      controller.validatePreviewInput({
        prompt: "a cat",
        negativePrompt: "blurry",
        aspectRatio: "1:1",
        style: "anime",
      })
    ).not.toThrow();
  });
});
