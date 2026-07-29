// SEC-7.3 — structured provider-error logging.
//
// The assertions that matter are the negative ones. This replaced
// console.dir(err, { depth: null }), whose danger was never its contents today
// but its open-endedness: an SDK that starts attaching a request object would
// have begun dumping prompts with no code change and no signal. So the tests
// below feed it exactly that and assert nothing escapes.

const { logProviderError, __testing } = require("../providerErrorLog");
const { safeMessage, bodyKeys, requestIdOf, statusOf, MAX_MESSAGE_CHARS } = __testing;

const SECRET_PROMPT = "a portrait of MY-SECRET-PROMPT-TEXT in watercolour";

beforeEach(() => {
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  console.error.mockRestore();
});

function logged() {
  return console.error.mock.calls.map((c) => String(c[0])).join("\n");
}

function parsed() {
  return JSON.parse(console.error.mock.calls[0][0]);
}

describe("the allowlist is a whitelist, not a filter", () => {
  it("emits exactly the approved field set and nothing else", () => {
    logProviderError({ provider: "fal", phase: "provider", error: new Error("boom") });

    // Pinned exactly: a field added later has to be a deliberate change to this
    // list, not something that arrives because an SDK started providing it.
    expect(Object.keys(parsed()).sort()).toEqual(
      [
        "bodyKeys",
        "endpoint",
        "errorName",
        "event",
        "kind",
        "message",
        "phase",
        "provider",
        "requestId",
        "status",
        "userId",
      ].sort()
    );
  });

  it("never passes the error object itself to console", () => {
    const err = new Error("boom");
    logProviderError({ provider: "fal", phase: "provider", error: err });

    // One argument, and it is a string. console.error(prefix, err) - the old
    // pattern - would have handed the live object to the transport.
    expect(console.error.mock.calls[0]).toHaveLength(1);
    expect(typeof console.error.mock.calls[0][0]).toBe("string");
  });
});

describe("request internals never escape", () => {
  it("drops a request object an SDK might attach in future", () => {
    // The actual regression this finding exists to prevent.
    const err = new Error("Request failed");
    err.request = { body: { prompt: SECRET_PROMPT }, headers: { authorization: "Bearer sk-live-xyz" } };
    err.config = { data: SECRET_PROMPT };

    logProviderError({ provider: "fal", phase: "provider", error: err });

    expect(logged()).not.toContain("MY-SECRET-PROMPT-TEXT");
    expect(logged()).not.toContain("sk-live-xyz");
    expect(logged()).not.toContain("authorization");
  });

  it("logs the shape of a response body, never its values", () => {
    const err = new Error("rejected");
    err.body = { detail: SECRET_PROMPT, request_id: "req-1", nested: { token: "t-123" } };

    logProviderError({ provider: "fal", phase: "provider", error: err });

    expect(parsed().bodyKeys).toEqual(["detail", "request_id", "nested"]);
    expect(logged()).not.toContain("MY-SECRET-PROMPT-TEXT");
    expect(logged()).not.toContain("t-123");
  });

  it("does the same for Stability's parsed error body", () => {
    // stabilityService puts the provider's parsed JSON body on `details`, and
    // the controller used to log it whole.
    const err = new Error("bad request");
    err.details = { name: "invalid_prompt", errors: [SECRET_PROMPT] };

    logProviderError({ provider: "stability", phase: "provider", error: err, kind: "bad_request" });

    expect(parsed().bodyKeys).toEqual(["name", "errors"]);
    expect(logged()).not.toContain("MY-SECRET-PROMPT-TEXT");
  });

  it("never logs an images array or buffers", () => {
    const err = new Error("failed");
    err.body = { images: [{ url: "https://cdn/secret.png" }] };

    logProviderError({ provider: "fal", phase: "provider", error: err });

    expect(logged()).not.toContain("cdn/secret.png");
    expect(parsed().bodyKeys).toEqual(["images"]);
  });
});

describe("bounded message", () => {
  it("truncates a long message", () => {
    // A provider is free to put anything in a message, plausibly including a
    // fragment of the offending prompt in a moderation refusal. Bounding it
    // caps how much can ride along without discarding a useful field.
    const err = new Error("x".repeat(MAX_MESSAGE_CHARS + 500));

    logProviderError({ provider: "fal", phase: "provider", error: err });

    expect(parsed().message).toHaveLength(MAX_MESSAGE_CHARS + "…[truncated]".length);
    expect(parsed().message).toMatch(/truncated/);
  });

  it("leaves a short message intact", () => {
    logProviderError({ provider: "fal", phase: "provider", error: new Error("upstream 502") });

    expect(parsed().message).toBe("upstream 502");
  });
});

describe("debuggability is preserved", () => {
  it("keeps the fields an operator actually needs", () => {
    const err = new Error("Service unavailable");
    err.name = "ApiError";
    err.status = 503;
    err.body = { request_id: "req-abc123" };

    logProviderError({
      provider: "fal",
      phase: "provider",
      error: err,
      userId: "user-1",
      endpoint: "POST /api/generate",
    });

    const p = parsed();
    expect(p.event).toBe("generation_provider_error");
    expect(p.provider).toBe("fal");
    expect(p.phase).toBe("provider");
    expect(p.errorName).toBe("ApiError");
    expect(p.status).toBe(503);
    // The single most useful field for a provider support conversation, and it
    // carries no request content.
    expect(p.requestId).toBe("req-abc123");
    expect(p.userId).toBe("user-1");
  });

  it("finds a request id under any of the names the SDKs use", () => {
    expect(requestIdOf({ requestId: "a" })).toBe("a");
    expect(requestIdOf({ request_id: "b" })).toBe("b");
    expect(requestIdOf({ body: { request_id: "c" } })).toBe("c");
    expect(requestIdOf({ body: { requestId: "d" } })).toBe("d");
    expect(requestIdOf({})).toBeNull();
  });

  it("finds a status under any of the usual shapes", () => {
    expect(statusOf({ status: 403 })).toBe(403);
    expect(statusOf({ statusCode: 429 })).toBe(429);
    expect(statusOf({ response: { status: 500 } })).toBe(500);
    expect(statusOf({ status: "403" })).toBeNull();
  });

  it("carries our own taxonomy through, which is safe by construction", () => {
    logProviderError({ provider: "stability", phase: "provider", error: new Error("x"), kind: "rate_limited" });

    expect(parsed().kind).toBe("rate_limited");
  });
});

describe("totality", () => {
  it.each([
    ["undefined error", undefined],
    ["null error", null],
    ["a string", "nope"],
    ["an empty object", {}],
  ])("survives %s", (_label, error) => {
    expect(() => logProviderError({ provider: "fal", phase: "provider", error })).not.toThrow();
  });

  it("survives a circular error object", () => {
    // console.dir handled cycles; JSON.stringify does not. Reading only named
    // scalar fields sidesteps the problem entirely - but pin it.
    const err = new Error("circular");
    err.self = err;
    err.body = { a: 1 };

    expect(() => logProviderError({ provider: "fal", phase: "provider", error: err })).not.toThrow();
    expect(parsed().message).toBe("circular");
  });

  it("survives a body that is an array or a primitive", () => {
    expect(bodyKeys([1, 2, 3])).toBeNull();
    expect(bodyKeys("text body")).toBeNull();
    expect(bodyKeys(null)).toBeNull();
  });

  it("survives a non-string message", () => {
    expect(safeMessage(undefined)).toBeNull();
    expect(safeMessage(42)).toBeNull();
  });
});
