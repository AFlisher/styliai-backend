// System Health module: pins that logProviderError() also calls
// systemIncidentModel.record() with the same already-sanitized fields it
// logs to console.error - see systemIncidentModel.js for why persistence
// itself is gated off under NODE_ENV=test (so this file mocks the model
// entirely rather than relying on that gate, mirroring how
// securityEvents.test.js tests the Operations Center's equivalent wiring).
//
// Kept separate from providerErrorLog.test.js, which pins the console.error
// output shape exactly and would be a confusing place to also assert against
// a mocked model.

jest.mock("../../models/systemIncidentModel", () => ({ record: jest.fn().mockResolvedValue(undefined) }));

const systemIncidentModel = require("../../models/systemIncidentModel");
const { logProviderError } = require("../providerErrorLog");

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  console.error.mockRestore();
});

describe("logProviderError persistence", () => {
  it("records a system_incidents row shaped from the same allowlisted fields it logs", () => {
    const err = new Error("Service unavailable");
    err.name = "ApiError";
    err.status = 503;
    err.body = { request_id: "req-abc123" };

    logProviderError({
      provider: "fal",
      phase: "provider",
      error: err,
      kind: "rate_limited",
      userId: "user-1",
      endpoint: "POST /api/generate",
    });

    expect(systemIncidentModel.record).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "image_provider",
        severity: "error",
        provider: "fal",
        phase: "provider",
        kind: "rate_limited",
        message: "Service unavailable",
        statusCode: 503,
        requestId: "req-abc123",
        userId: "user-1",
        endpoint: "POST /api/generate",
        detail: { bodyKeys: ["request_id"], errorName: "ApiError" },
      })
    );
  });

  it("never throws even if the model rejects, since callers don't await this", () => {
    systemIncidentModel.record.mockRejectedValueOnce(new Error("db down"));

    expect(() => logProviderError({ provider: "fal", phase: "provider", error: new Error("x") })).not.toThrow();
  });

  it("still redacts request internals before they ever reach the model", () => {
    const err = new Error("Request failed");
    err.request = { body: { prompt: "SECRET" }, headers: { authorization: "Bearer sk-live-xyz" } };

    logProviderError({ provider: "fal", phase: "provider", error: err });

    const entry = systemIncidentModel.record.mock.calls[0][0];
    expect(JSON.stringify(entry)).not.toContain("SECRET");
    expect(JSON.stringify(entry)).not.toContain("sk-live-xyz");
  });
});
