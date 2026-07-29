// SEC-7.2 — fal.
//
// fal is the provider this finding is really about: it had TWO unbounded
// network operations - the queued subscribe, and a separate download of the
// result URL. Both are now bounded, and each gets its own budget, because a CDN
// download has no business inheriting a generation-sized allowance.

process.env.FAL_API_KEY = "test-key";
process.env.GENERATION_TIMEOUT_MS = "80";
process.env.GENERATION_DOWNLOAD_TIMEOUT_MS = "40";

const mockSubscribe = jest.fn();
jest.mock("@fal-ai/client", () => ({
  fal: { config: jest.fn(), subscribe: (...a) => mockSubscribe(...a), storage: { upload: jest.fn() } },
}));

const FalProvider = require("../falProvider");
const { generationTimeouts } = require("../../../config/generationTimeouts");

const never = (signal) =>
  new Promise((_r, reject) =>
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
  );

let provider;

beforeEach(() => {
  jest.clearAllMocks();
  provider = new FalProvider();
  global.fetch = jest.fn();
});

function generate(extra = {}) {
  return provider.generateImage({
    images: [{ buffer: Buffer.from("src"), mimeType: "image/jpeg" }],
    imageBuffer: Buffer.from("src"),
    mimeType: "image/jpeg",
    prompt: "a portrait",
    ...extra,
  });
}

describe("the two budgets are separate", () => {
  it("reads distinct values from configuration", () => {
    // One shared constant for both would mean a stalled CDN could hold a
    // request for as long as a whole generation.
    expect(generationTimeouts.providerMs).toBe(80);
    expect(generationTimeouts.downloadMs).toBe(40);
    expect(generationTimeouts.downloadMs).toBeLessThan(generationTimeouts.providerMs);
  });
});

describe("the subscribe call is bounded", () => {
  it("passes an abortSignal to fal.subscribe", async () => {
    mockSubscribe.mockResolvedValue({ data: { images: [{ url: "https://cdn/x.png" }] } });
    global.fetch.mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });

    await generate().catch(() => {});

    expect(mockSubscribe.mock.calls[0][1].abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("times out a hung subscribe rather than waiting forever", async () => {
    mockSubscribe.mockImplementation((_id, opts) => never(opts.abortSignal));

    const err = await generate().catch((e) => e);

    expect(err.isGenerationTimeout).toBe(true);
    expect(err.phase).toBe("provider");
  });
});

describe("the result download is bounded separately", () => {
  it("passes a signal to the download fetch", async () => {
    mockSubscribe.mockResolvedValue({ data: { images: [{ url: "https://cdn/x.png" }] } });
    global.fetch.mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });

    await generate().catch(() => {});

    expect(global.fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("times out a stalled download and names the download phase", async () => {
    mockSubscribe.mockResolvedValue({ data: { images: [{ url: "https://cdn/x.png" }] } });
    global.fetch.mockImplementation((_url, opts) => never(opts.signal));

    const err = await generate().catch((e) => e);

    expect(err.isGenerationTimeout).toBe(true);
    // Naming the phase is what makes "the provider is slow" and "the CDN is
    // slow" separable in the logs.
    expect(err.phase).toBe("download");
  });
});
