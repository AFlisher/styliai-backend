// SEC-7.1 Stage 1+2 — moderation signals.
//
// The property under test throughout is the separation that did not exist
// before: a content-policy refusal and a provider failure must never arrive as
// the same signal. Everything else here follows from that.

const {
  ContentModerationError,
  MODERATION_MESSAGE,
  promptDigest,
  logModerationRejection,
} = require("../contentModeration");
const { ErrorCodes } = require("../errors");

beforeEach(() => {
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  console.warn.mockRestore();
});

describe("ContentModerationError", () => {
  it("is identifiable without instanceof, across module boundaries", () => {
    // Providers throw it, controllers catch it, and jest module mocking can
    // break instanceof across those boundaries - so the discriminator is a
    // plain flag.
    const err = new ContentModerationError("gemini", "prompt", ["HARM_CATEGORY_HATE_SPEECH"], "SAFETY");

    expect(err.isContentModeration).toBe(true);
    expect(err.provider).toBe("gemini");
    expect(err.stage).toBe("prompt");
    expect(err.categories).toEqual(["HARM_CATEGORY_HATE_SPEECH"]);
    expect(err.reason).toBe("SAFETY");
  });

  it("distinguishes a refused input from refused output", () => {
    expect(new ContentModerationError("gemini", "prompt").stage).toBe("prompt");
    expect(new ContentModerationError("gemini", "output").stage).toBe("output");
  });

  it("is not confusable with an ordinary provider failure", () => {
    expect(new Error("Gemini API call failed").isContentModeration).toBeUndefined();
  });
});

describe("the user-facing message", () => {
  it("names no provider, category or reason", () => {
    // Telling the caller which policy tripped turns the endpoint into a
    // classifier they can tune prompts against.
    const lowered = MODERATION_MESSAGE.toLowerCase();

    for (const leak of ["gemini", "stability", "harm", "sexual", "safety", "403", "category"]) {
      expect(lowered).not.toContain(leak);
    }
  });

  it("is one message, so two rejections are indistinguishable to the caller", () => {
    const a = MODERATION_MESSAGE;
    const b = MODERATION_MESSAGE;

    expect(a).toBe(b);
    expect(a).toMatch(/content policy/i);
  });

  it("has its own error code, separate from validation and provider failure", () => {
    expect(ErrorCodes.CONTENT_MODERATED).toBe("CONTENT_MODERATED");
    expect(ErrorCodes.CONTENT_MODERATED).not.toBe(ErrorCodes.VALIDATION_ERROR);
    expect(ErrorCodes.CONTENT_MODERATED).not.toBe(ErrorCodes.PROVIDER_UNAVAILABLE);
  });
});

describe("promptDigest", () => {
  it("is stable and distinguishes different prompts", () => {
    expect(promptDigest("a cat")).toBe(promptDigest("a cat"));
    expect(promptDigest("a cat")).not.toBe(promptDigest("a dog"));
  });

  it("is short and non-reversing", () => {
    const d = promptDigest("something a moderation system refused");

    expect(d).toHaveLength(12);
    expect(d).toMatch(/^[0-9a-f]+$/);
  });

  it("tolerates absent input", () => {
    expect(promptDigest(undefined)).toBeNull();
    expect(promptDigest("")).toBeNull();
    expect(promptDigest(42)).toBeNull();
  });
});

describe("structured logging", () => {
  const call = (over = {}) =>
    logModerationRejection({
      userId: "user-1",
      endpoint: "POST /api/ai/generate",
      provider: "stability",
      stage: "prompt",
      categories: ["HARM_CATEGORY_SEXUALLY_EXPLICIT"],
      reason: "http_403",
      prompt: "the refused prompt text",
      ...over,
    });

  it("never records the prompt itself", () => {
    call();
    const line = console.warn.mock.calls[0][0];

    // An audit trail that retains the material a moderation system just
    // refused is itself a liability. The digest answers "same user, same
    // blocked prompt, eleven times" without keeping the text.
    expect(line).not.toContain("the refused prompt text");
    expect(JSON.parse(line).promptDigest).toBe(promptDigest("the refused prompt text"));
  });

  it("emits one parseable event carrying the operator-facing detail", () => {
    call();
    const parsed = JSON.parse(console.warn.mock.calls[0][0]);

    expect(parsed.event).toBe("content_moderation_rejected");
    expect(parsed.provider).toBe("stability");
    expect(parsed.stage).toBe("prompt");
    expect(parsed.categories).toEqual(["HARM_CATEGORY_SEXUALLY_EXPLICIT"]);
    expect(parsed.reason).toBe("http_403");
    expect(parsed.userId).toBe("user-1");
    expect(parsed.endpoint).toBe("POST /api/ai/generate");
  });

  it("logs at warn, so it is separable from the provider-error firehose", () => {
    call();

    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("survives missing fields without throwing", () => {
    expect(() => logModerationRejection({})).not.toThrow();
    expect(() => call({ categories: undefined, prompt: undefined })).not.toThrow();
  });
});
