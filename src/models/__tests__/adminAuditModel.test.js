// SEC-15.1: the audit log is only worth having if what it stores is bounded
// and free of credential material. These pin both properties on the pure
// sanitizer, plus the insert's column mapping.

jest.mock("../../config/db", () => ({ query: jest.fn(), pool: { connect: jest.fn() } }));

const db = require("../../config/db");
const {
  record,
  recordWithClient,
  sanitizePayload,
  MAX_PAYLOAD_BYTES,
} = require("../adminAuditModel");

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockResolvedValue({ rows: [{ id: "audit-1" }] });
});

describe("sanitizePayload - credential filtering", () => {
  it.each([
    ["password", { password: "hunter2" }],
    ["passwordHash", { passwordHash: "$2b$12$xxx" }],
    ["token", { token: "11111111-2222-3333-4444-555555555555" }],
    ["accessToken", { accessToken: "eyJhbGciOi" }],
    ["apiKey", { apiKey: "sk-live-abc" }],
    ["api_key", { api_key: "sk-live-abc" }],
    ["secret", { secret: "s3cr3t" }],
    ["authorization", { authorization: "Bearer abc" }],
    ["credentials", { credentials: "abc" }],
  ])("redacts a top-level %s", (_label, input) => {
    const out = sanitizePayload(input);
    const key = Object.keys(input)[0];

    expect(out[key]).toBe("[REDACTED]");
    // The secret must be absent from the whole serialized record, not merely
    // absent from the field we happened to check.
    expect(JSON.stringify(out)).not.toContain(input[key]);
  });

  it("redacts nested and array-nested credentials", () => {
    const out = sanitizePayload({
      outer: { inner: { apiKey: "SENTINEL-KEY" } },
      list: [{ password: "SENTINEL-PASS" }],
    });

    expect(JSON.stringify(out)).not.toContain("SENTINEL-KEY");
    expect(JSON.stringify(out)).not.toContain("SENTINEL-PASS");
  });

  it("leaves ordinary catalog fields untouched", () => {
    // Every field the dashboard actually submits for a style, including the
    // nested field definitions. If the credential pattern ever grows a term
    // that collides with one of these (`placeholder` and `negativePrompt` are
    // the near-misses), this test is what catches it - a redacted prompt is a
    // silently corrupted audit record.
    const style = {
      name: "Cyberpunk",
      prompt: "a portrait in neon",
      negativePrompt: "blurry, low quality",
      coverImage: "https://example.com/a.jpg",
      creditCost: 2,
      isEnabled: true,
      isPremium: false,
      tagIds: ["a", "b"],
      fields: [{ key: "subject", label: "Subject", type: "text", placeholder: "a person" }],
    };

    expect(sanitizePayload(style)).toEqual(style);
  });

  it("summarizes a Buffer instead of serializing it", () => {
    // A serialized 10 MB Buffer is a ~50 MB string, built before the size cap
    // could reject it.
    const out = sanitizePayload({ file: Buffer.alloc(1024 * 1024) });

    expect(out.file).toEqual({ _buffer: true, _bytes: 1024 * 1024 });
    expect(Buffer.byteLength(JSON.stringify(out), "utf8")).toBeLessThan(200);
  });
});

describe("sanitizePayload - size cap", () => {
  it("stores an oversized payload as a marked, bounded preview", () => {
    const huge = { prompt: "x".repeat(MAX_PAYLOAD_BYTES * 2) };

    const out = sanitizePayload(huge);

    expect(out._truncated).toBe(true);
    expect(out._originalBytes).toBeGreaterThan(MAX_PAYLOAD_BYTES);
    expect(Buffer.byteLength(JSON.stringify(out), "utf8")).toBeLessThan(MAX_PAYLOAD_BYTES);
  });

  it("keeps a realistically sized payload intact", () => {
    const realistic = { prompt: "x".repeat(1500), name: "A style" };

    expect(sanitizePayload(realistic)).toEqual(realistic);
  });
});

describe("sanitizePayload - totality", () => {
  it("returns null for nothing to record", () => {
    expect(sanitizePayload(undefined)).toBeNull();
    expect(sanitizePayload(null)).toBeNull();
  });

  it("flattens a circular structure into a bounded, serializable payload", () => {
    const circular = { name: "x" };
    circular.self = circular;

    // The depth cap severs the cycle before JSON.stringify ever sees it, so
    // this yields a finite tree rather than a throw. What matters is that the
    // result is bounded and serializable, not its exact shape.
    const out = sanitizePayload(circular);

    expect(() => JSON.stringify(out)).not.toThrow();
    expect(Buffer.byteLength(JSON.stringify(out), "utf8")).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    expect(JSON.stringify(out)).toContain("[MAX_DEPTH]");
  });

  it("marks a payload JSON cannot represent rather than losing the action", () => {
    // BigInt makes JSON.stringify throw outright - the one case the catch in
    // sanitizePayload exists for. Losing the payload is acceptable; losing the
    // fact that the action happened is not.
    expect(sanitizePayload({ amount: BigInt(9) })).toEqual({ _unserializable: true });
  });

  it("does not throw on a throwing getter", () => {
    const hostile = {};
    Object.defineProperty(hostile, "boom", {
      enumerable: true,
      get() {
        throw new Error("nope");
      },
    });

    expect(() => sanitizePayload(hostile)).not.toThrow();
  });

  it("does not blow the stack on a deeply nested payload", () => {
    let deep = { end: true };
    for (let i = 0; i < 5000; i++) deep = { next: deep };

    expect(() => sanitizePayload(deep)).not.toThrow();
  });
});

describe("record", () => {
  it("maps the entry onto the audit columns in order", async () => {
    await record({
      adminId: "admin-1",
      adminEmail: "admin@example.com",
      action: "DELETE /api/styles/:id",
      targetType: "styles",
      targetId: "style-9",
      before: { name: "Old" },
      after: null,
      ip: "203.0.113.7",
      requestUrl: "/api/styles/style-9",
      statusCode: 204,
    });

    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0];

    expect(sql).toContain("INSERT INTO admin_audit_log");
    expect(params).toEqual([
      "admin-1",
      "admin@example.com",
      "DELETE /api/styles/:id",
      "styles",
      "style-9",
      JSON.stringify({ name: "Old" }),
      null,
      "203.0.113.7",
      "/api/styles/style-9",
      204,
    ]);
  });
});

describe("recordWithClient", () => {
  it("writes on the caller's client, never on the pool", async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [{ id: "audit-2" }] }) };

    await recordWithClient(client, {
      adminId: "admin-1",
      action: "POST /api/admin/users/:id/adjust-balance",
      before: { balance: 10 },
      after: { balance: 15 },
    });

    expect(client.query).toHaveBeenCalledTimes(1);
    // Using the pool here instead of the client would silently break the
    // fail-closed guarantee: the audit row would commit independently of the
    // balance change it is supposed to be atomic with.
    expect(db.query).not.toHaveBeenCalled();
  });
});
