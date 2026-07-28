// SEC-15.8: input bounds on the admin preview endpoint.
//
// This endpoint calls a per-image metered provider with no wallet charge, so
// the assertion that matters throughout is not just "returns 400" but
// "the provider was NEVER CALLED" - a rejection that still pays for an image
// is not a fix.

jest.mock("../../services/stabilityService", () => {
  class StabilityApiError extends Error {
    constructor(kind, message) {
      super(message);
      this.kind = kind;
    }
  }
  return { StabilityApiError, generateImage: jest.fn() };
});
jest.mock("../../services/wallet/walletService", () => ({
  deductBalance: jest.fn(),
  addBalance: jest.fn(),
}));
jest.mock("../../models/creationsModel", () => ({ addCreation: jest.fn() }));
jest.mock("../../models/styleModel", () => ({ getStyleById: jest.fn() }));

const stabilityService = require("../../services/stabilityService");
const {
  adminPreviewGenerate,
  validatePreviewInput,
  MAX_PROMPT_LENGTH,
  MAX_NEGATIVE_PROMPT_LENGTH,
  ALLOWED_ASPECT_RATIOS,
  ALLOWED_STYLE_PRESETS,
} = require("../stabilityController");

function makeReqRes(body) {
  return {
    req: { body, admin: { id: "admin-1", role: "admin", adminRole: "editor" } },
    res: { status: jest.fn().mockReturnThis(), json: jest.fn() },
    next: jest.fn(),
  };
}

function expect400(next) {
  expect(next).toHaveBeenCalledWith(
    expect.objectContaining({ code: "VALIDATION_ERROR", statusCode: 400 })
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  stabilityService.generateImage.mockResolvedValue({ imageUrl: "https://example.com/a.webp" });
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => console.error.mockRestore());

describe("prompt length", () => {
  it("rejects a prompt over the cap without paying for it", async () => {
    const { req, res, next } = makeReqRes({ prompt: "x".repeat(MAX_PROMPT_LENGTH + 1) });

    await adminPreviewGenerate(req, res, next);

    expect400(next);
    // The whole point: no provider call, so no image was billed.
    expect(stabilityService.generateImage).not.toHaveBeenCalled();
  });

  it("accepts a prompt exactly at the cap", async () => {
    const { req, res, next } = makeReqRes({ prompt: "x".repeat(MAX_PROMPT_LENGTH) });

    await adminPreviewGenerate(req, res, next);

    expect(stabilityService.generateImage).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
  });

  it("accepts the largest prompt in the live catalog", async () => {
    // Measured at 4,643 characters when this cap was chosen. The cap must not
    // reject real work.
    const { req, res, next } = makeReqRes({ prompt: "x".repeat(4643) });

    await adminPreviewGenerate(req, res, next);

    expect(stabilityService.generateImage).toHaveBeenCalledTimes(1);
  });

  it("still rejects an empty prompt, as before", async () => {
    const { req, res, next } = makeReqRes({ prompt: "   " });

    await adminPreviewGenerate(req, res, next);

    expect400(next);
    expect(stabilityService.generateImage).not.toHaveBeenCalled();
  });
});

describe("negativePrompt length", () => {
  it("rejects a negativePrompt over the cap without paying for it", async () => {
    const { req, res, next } = makeReqRes({
      prompt: "a cat",
      negativePrompt: "y".repeat(MAX_NEGATIVE_PROMPT_LENGTH + 1),
    });

    await adminPreviewGenerate(req, res, next);

    expect400(next);
    expect(stabilityService.generateImage).not.toHaveBeenCalled();
  });

  it("accepts one exactly at the cap", async () => {
    const { req, res, next } = makeReqRes({
      prompt: "a cat",
      negativePrompt: "y".repeat(MAX_NEGATIVE_PROMPT_LENGTH),
    });

    await adminPreviewGenerate(req, res, next);

    expect(stabilityService.generateImage).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-string negativePrompt", async () => {
    const { req, res, next } = makeReqRes({ prompt: "a cat", negativePrompt: 42 });

    await adminPreviewGenerate(req, res, next);

    expect400(next);
    expect(stabilityService.generateImage).not.toHaveBeenCalled();
  });
});

describe("aspectRatio allow-list", () => {
  it.each([...ALLOWED_ASPECT_RATIOS])("forwards the supported value %s", async (ratio) => {
    const { req, res, next } = makeReqRes({ prompt: "a cat", aspectRatio: ratio });

    await adminPreviewGenerate(req, res, next);

    expect(stabilityService.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({ aspectRatio: ratio })
    );
  });

  it.each([
    ["nonsense", "999:1--not-a-real-ratio"],
    ["a near-miss", "16:10"],
    ["different spacing", "16 : 9"],
    ["empty string", ""],
    ["a number", 169],
    ["an object", {}],
    ["a prototype key", "constructor"],
  ])("rejects %s without paying for it", async (_label, aspectRatio) => {
    const { req, res, next } = makeReqRes({ prompt: "a cat", aspectRatio });

    await adminPreviewGenerate(req, res, next);

    expect400(next);
    expect(stabilityService.generateImage).not.toHaveBeenCalled();
  });
});

describe("style allow-list", () => {
  it.each([...ALLOWED_STYLE_PRESETS])("forwards the supported preset %s", async (style) => {
    const { req, res, next } = makeReqRes({ prompt: "a cat", style });

    await adminPreviewGenerate(req, res, next);

    expect(stabilityService.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({ style })
    );
  });

  it.each([
    ["an unknown preset", "watercolour"],
    ["injection-shaped text", "'; DROP TABLE styles; --"],
    ["wrong casing", "Photographic"],
    ["a prototype key", "toString"],
  ])("rejects %s without paying for it", async (_label, style) => {
    const { req, res, next } = makeReqRes({ prompt: "a cat", style });

    await adminPreviewGenerate(req, res, next);

    expect400(next);
    expect(stabilityService.generateImage).not.toHaveBeenCalled();
  });
});

describe("the shape the dashboard actually sends", () => {
  it("accepts { prompt } alone and forwards the optionals as undefined", async () => {
    // api.ts previewStabilityStyle posts exactly this and nothing else, so the
    // allow-lists must not make the real client's request invalid.
    const { req, res, next } = makeReqRes({ prompt: "a cat astronaut" });

    await adminPreviewGenerate(req, res, next);

    expect(stabilityService.generateImage).toHaveBeenCalledWith({
      prompt: "a cat astronaut",
      negativePrompt: undefined,
      aspectRatio: undefined,
      style: undefined,
    });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("tolerates an absent body without throwing a TypeError", async () => {
    const { res, next } = makeReqRes(undefined);
    const req = { admin: { id: "admin-1" } };

    await adminPreviewGenerate(req, res, next);

    expect400(next);
    expect(stabilityService.generateImage).not.toHaveBeenCalled();
  });
});

describe("validatePreviewInput is pure and total", () => {
  it("returns the validated values unchanged", () => {
    const input = {
      prompt: "a cat",
      negativePrompt: "blurry",
      aspectRatio: "16:9",
      style: "photographic",
    };

    expect(validatePreviewInput(input)).toEqual(input);
  });

  it("treats null optionals as absent, not as invalid", () => {
    const out = validatePreviewInput({
      prompt: "a cat",
      negativePrompt: null,
      aspectRatio: null,
      style: null,
    });

    expect(out.prompt).toBe("a cat");
  });

  it("uses exact-match sets, so no substring sneaks through", () => {
    expect(() => validatePreviewInput({ prompt: "a", style: "anime-extra" })).toThrow();
    expect(() => validatePreviewInput({ prompt: "a", aspectRatio: "16:9x" })).toThrow();
  });
});
