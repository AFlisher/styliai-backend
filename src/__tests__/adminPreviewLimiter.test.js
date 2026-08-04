// SEC-15.8: the preview limiter is keyed by admin id, and the route ordering
// that makes that possible.
//
// The key is the security property. An IP-keyed budget on a spend-bounding
// limiter is evadable by the one dimension the caller fully controls, so these
// pin both the key function and the middleware order it depends on.

process.env.ADMIN_JWT_SECRET = "test-only-admin-secret";

jest.mock("../config/db", () => ({
  query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  pool: { connect: jest.fn() },
}));

jest.mock("../services/stabilityService", () => {
  class StabilityApiError extends Error {}
  return {
    StabilityApiError,
    generateImage: jest.fn().mockResolvedValue({ imageUrl: "https://example.com/a.webp" }),
  };
});
// Phase 6: the auth middlewares now read session state per request. See the
// helper for why this is mocked rather than queued into each db.query stub.
jest.mock("../services/sessionService", () => require("../../test/mocks/activeSession"));

const request = require("supertest");
const jwt = require("jsonwebtoken");
const stabilityService = require("../services/stabilityService");
const { adminOrIpKeyGenerator, LIMIT_VALUES } = require("../middleware/rateLimiters");
const app = require("../app");

const PATH = "/api/admin/ai/generate-preview";

function tokenFor(id, adminRole = "editor") {
  return jwt.sign(
    { sub: id, email: `${id}@example.com`, role: "admin", adminRole },
    process.env.ADMIN_JWT_SECRET,
    { algorithm: "HS256", expiresIn: "5m" }
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  stabilityService.generateImage.mockResolvedValue({ imageUrl: "https://example.com/a.webp" });
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => console.error.mockRestore());

describe("adminOrIpKeyGenerator", () => {
  it("keys by the verified admin id when one is present", () => {
    expect(adminOrIpKeyGenerator({ admin: { id: "admin-7" }, ip: "203.0.113.9" })).toBe("admin-7");
  });

  it("falls back to the IP when no admin is set", () => {
    // Never keyless: if the route ordering is ever broken, the limiter must
    // still bucket by something rather than sharing one global budget.
    expect(adminOrIpKeyGenerator({ ip: "203.0.113.9" })).toBeTruthy();
  });

  it("does not take the id from the request body or headers", () => {
    const key = adminOrIpKeyGenerator({
      ip: "203.0.113.9",
      body: { admin: { id: "forged" } },
      headers: { "x-admin-id": "forged" },
    });

    expect(key).not.toBe("forged");
  });
});

describe("route ordering (SEC-15.8)", () => {
  it("authenticates before the limiter, so an unauthenticated flood cannot consume a budget", async () => {
    const limit = LIMIT_VALUES.adminGenerationPreviewLimiter.limit;

    for (let i = 0; i < limit + 3; i++) {
      const res = await request(app).post(PATH).send({ prompt: "a cat" });
      // Always 401 - never 429. A request rejected by authentication never
      // reaches the limiter, and never reaches the paid provider either.
      expect(res.status).toBe(401);
    }

    expect(stabilityService.generateImage).not.toHaveBeenCalled();
  });

  it("still enforces the role guard after the limiter", async () => {
    const res = await request(app)
      .post(PATH)
      .set("Authorization", `Bearer ${tokenFor("admin-viewer", "viewer")}`)
      .send({ prompt: "a cat" });

    expect(res.status).toBe(403);
    expect(stabilityService.generateImage).not.toHaveBeenCalled();
  });

  it("validates before calling the provider, even for an authorized admin", async () => {
    const res = await request(app)
      .post(PATH)
      .set("Authorization", `Bearer ${tokenFor("admin-a")}`)
      .send({ prompt: "x".repeat(10001) });

    expect(res.status).toBe(400);
    expect(stabilityService.generateImage).not.toHaveBeenCalled();
  });
});

describe("SEC-15.1 non-regression: previews are still audited, cheap rejects are not", () => {
  const db = require("../config/db");

  function auditWrites() {
    return db.query.mock.calls.filter(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO admin_audit_log")
    );
  }

  async function flush() {
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  }

  it("still writes exactly one audit row for a successful preview", async () => {
    // SEC-15.8 deliberately changed nothing about admin_audit_log; the global
    // middleware from SEC-15.1 already covers this route. This pins that the
    // route reorder did not disturb it.
    db.query.mockClear();

    const res = await request(app)
      .post(PATH)
      .set("Authorization", `Bearer ${tokenFor("admin-audited")}`)
      .send({ prompt: "a cat" });
    expect(res.status).toBe(200);

    await flush();

    const writes = auditWrites();
    expect(writes).toHaveLength(1);
    expect(writes[0][1][2]).toBe("POST /api/admin/ai/generate-preview");
  });

  it("writes no audit row when validation rejects the request", async () => {
    // A locally-rejected request costs nothing and reached no provider, so it
    // is not an action worth recording - and letting 400s in would let anyone
    // with an admin token flood the audit table for free.
    db.query.mockClear();

    const res = await request(app)
      .post(PATH)
      .set("Authorization", `Bearer ${tokenFor("admin-rejected")}`)
      .send({ prompt: "x".repeat(10001) });
    expect(res.status).toBe(400);

    await flush();

    expect(auditWrites()).toHaveLength(0);
  });
});

describe("budgets follow the admin, not the address", () => {
  it("exhausts one admin's budget and leaves another admin unaffected", async () => {
    const limit = LIMIT_VALUES.adminGenerationPreviewLimiter.limit;

    // Same source address throughout - supertest uses one loopback socket - so
    // if the key were still the IP, the second admin below would be throttled
    // by the first admin's traffic.
    let last;
    for (let i = 0; i < limit + 1; i++) {
      last = await request(app)
        .post(PATH)
        .set("Authorization", `Bearer ${tokenFor("admin-heavy")}`)
        .send({ prompt: "a cat" });
    }
    expect(last.status).toBe(429);

    const other = await request(app)
      .post(PATH)
      .set("Authorization", `Bearer ${tokenFor("admin-quiet")}`)
      .send({ prompt: "a cat" });

    expect(other.status).toBe(200);
  });

  it("does not let one admin escape their budget by changing address", async () => {
    const limit = LIMIT_VALUES.adminGenerationPreviewLimiter.limit;
    const token = tokenFor("admin-rotator");

    let last;
    for (let i = 0; i < limit + 1; i++) {
      last = await request(app)
        .post(PATH)
        .set("Authorization", `Bearer ${token}`)
        // app.js sets `trust proxy: 2`, so this is how a caller influences the
        // resolved req.ip - the exact evasion an IP key was vulnerable to.
        .set("X-Forwarded-For", `198.51.100.${i}, 203.0.113.1`)
        .send({ prompt: "a cat" });
    }

    expect(last.status).toBe(429);
  });
});
