// SEC-7.1 Stage 1+2 — Gemini.
//
// Before this, Gemini's safety signals were never read: a block surfaced as
// "Received an empty image buffer", i.e. as an outage. These tests pin that a
// refusal is now a refusal, that an outage is still an outage, and that the
// declared safety posture actually reaches the API call.

const mockGenerateContent = jest.fn();

jest.mock("@google/genai", () => ({
  GoogleGenAI: jest.fn().mockImplementation(() => ({
    models: { generateContent: mockGenerateContent },
  })),
}));

const GeminiProvider = require("../geminiProvider");

const IMAGE_B64 = Buffer.from("fake-png-bytes").toString("base64");

function okResponse() {
  return {
    candidates: [
      { finishReason: "STOP", content: { parts: [{ inlineData: { data: IMAGE_B64 } }] } },
    ],
  };
}

function generate(provider) {
  return provider.generateImage({
    images: [{ buffer: Buffer.from("src"), mimeType: "image/jpeg" }],
    prompt: "a portrait in watercolour",
  });
}

let provider;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GEMINI_API_KEY = "test-key";
  provider = new GeminiProvider();
});

describe("Stage 2 — declared safety posture", () => {
  it("sends explicit safetySettings rather than inheriting defaults", async () => {
    mockGenerateContent.mockResolvedValue(okResponse());

    await generate(provider);

    const { config } = mockGenerateContent.mock.calls[0][0];
    expect(Array.isArray(config.safetySettings)).toBe(true);
    expect(config.safetySettings.length).toBeGreaterThanOrEqual(4);
  });

  it("covers every harm category Gemini exposes", async () => {
    mockGenerateContent.mockResolvedValue(okResponse());

    await generate(provider);

    const categories = mockGenerateContent.mock.calls[0][0].config.safetySettings.map((s) => s.category);
    expect(categories).toEqual(
      expect.arrayContaining([
        "HARM_CATEGORY_HARASSMENT",
        "HARM_CATEGORY_HATE_SPEECH",
        "HARM_CATEGORY_SEXUALLY_EXPLICIT",
        "HARM_CATEGORY_DANGEROUS_CONTENT",
      ])
    );
  });

  it("never ships BLOCK_NONE", async () => {
    // This app takes user-uploaded photographs of people. Loosening any
    // category is a policy decision with legal weight, not a tuning knob.
    mockGenerateContent.mockResolvedValue(okResponse());

    await generate(provider);

    const thresholds = mockGenerateContent.mock.calls[0][0].config.safetySettings.map((s) => s.threshold);
    expect(thresholds).not.toContain("BLOCK_NONE");
    expect(thresholds.every((t) => t === "BLOCK_MEDIUM_AND_ABOVE")).toBe(true);
  });
});

describe("Stage 1 — a refusal is reported as a refusal", () => {
  it("recognises a blocked prompt", async () => {
    mockGenerateContent.mockResolvedValue({
      promptFeedback: {
        blockReason: "SAFETY",
        safetyRatings: [{ category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", probability: "HIGH", blocked: true }],
      },
    });

    await expect(generate(provider)).rejects.toMatchObject({
      isContentModeration: true,
      provider: "gemini",
      stage: "prompt",
      reason: "SAFETY",
      categories: ["HARM_CATEGORY_SEXUALLY_EXPLICIT"],
    });
  });

  it.each([["SAFETY"], ["PROHIBITED_CONTENT"], ["IMAGE_SAFETY"], ["BLOCKLIST"], ["SPII"]])(
    "recognises a %s finishReason on the output",
    async (finishReason) => {
      mockGenerateContent.mockResolvedValue({ candidates: [{ finishReason }] });

      await expect(generate(provider)).rejects.toMatchObject({
        isContentModeration: true,
        stage: "output",
        reason: finishReason,
      });
    }
  );

  it("reports only the categories that actually tripped", async () => {
    mockGenerateContent.mockResolvedValue({
      candidates: [
        {
          finishReason: "SAFETY",
          safetyRatings: [
            { category: "HARM_CATEGORY_HATE_SPEECH", probability: "NEGLIGIBLE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", probability: "HIGH" },
          ],
        },
      ],
    });

    await expect(generate(provider)).rejects.toMatchObject({
      categories: ["HARM_CATEGORY_DANGEROUS_CONTENT"],
    });
  });
});

describe("an outage is still an outage", () => {
  it("a genuine API failure is not a moderation rejection", async () => {
    mockGenerateContent.mockRejectedValue(new Error("503 backend unavailable"));

    // The whole point of the split: conflating these would report a Gemini
    // outage to users as a content-policy violation.
    //
    // Caught and asserted rather than matched: toMatchObject treats an absent
    // property and an undefined one as equal, so it would pass whatever the
    // provider threw - the same vacuity trap SEC-17.1 documented.
    const err = await generate(provider).catch((e) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err.isContentModeration).toBeUndefined();
    expect(err.message).toMatch(/API call failed/i);
  });

  it("an empty response without a block reason stays a provider error", async () => {
    mockGenerateContent.mockResolvedValue({ candidates: [{ finishReason: "STOP", content: { parts: [] } }] });

    const err = await generate(provider).catch((e) => e);

    expect(err.isContentModeration).toBeUndefined();
    expect(err.message).toMatch(/empty response/i);
  });

  it("a normal STOP finishReason generates as before", async () => {
    mockGenerateContent.mockResolvedValue(okResponse());

    await expect(generate(provider)).resolves.toBeInstanceOf(Buffer);
  });

  it("an unrecognised finishReason is not assumed to be moderation", async () => {
    // Guessing a refusal from an unknown value is how an outage starts being
    // reported as a policy violation.
    mockGenerateContent.mockResolvedValue({
      candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ inlineData: { data: IMAGE_B64 } }] } }],
    });

    await expect(generate(provider)).resolves.toBeInstanceOf(Buffer);
  });
});
