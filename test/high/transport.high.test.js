/**
 * High-priority transport/edge suite (QA_TEST_PLAN.md):
 *   API-013, API-019, API-021, SEC-017
 */

require("../critical/setupEnv");

jest.mock("../../src/config/db", () => require("../critical/fakeDb"));
jest.mock("../../src/config/supabase", () => ({ storage: { from: () => ({}) } }));
jest.mock("../../src/services/generation/generationService", () => ({ generate: jest.fn() }));

const jwt = require("jsonwebtoken");
const request = require("supertest");
const app = require("../../src/app");
const fakeDb = require("../critical/fakeDb");

const userToken = (id) =>
  jwt.sign({ sub: id, email: `${id}@x.com`, role: "authenticated" }, process.env.SUPABASE_JWT_SECRET, { expiresIn: "1h" });

beforeEach(() => fakeDb.reset());

describe("API-013 — /api/generate rejects files over the 10MB limit", () => {
  it("returns 400 (too large), not a 500 or a provider call", async () => {
    fakeDb.seedUser({ id: "big", balance: 10, email_verified: true });
    fakeDb.seedStyle({ id: "sbig", creditCost: 1, isEnabled: true });
    const oversized = Buffer.alloc(11 * 1024 * 1024, 1); // 11MB

    const res = await request(app)
      .post("/api/generate")
      .set("Authorization", `Bearer ${userToken("big")}`)
      .field("styleId", "sbig")
      .attach("file", oversized, { filename: "big.png", contentType: "image/png" });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/too large|10MB/i);
  });
});

describe("API-019 — CORS origin allow-list", () => {
  it("echoes Access-Control-Allow-Origin for an allowed origin", async () => {
    const res = await request(app).get("/").set("Origin", "http://localhost:5173");
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
  });

  it("does not grant CORS access to a disallowed origin", async () => {
    const res = await request(app).get("/").set("Origin", "http://evil.example.com");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("allows non-browser requests with no Origin header (e.g. mobile app, Postman)", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
  });
});

describe("API-021 / SEC-017 — auth routes are rate limited (brute-force protection)", () => {
  it("returns 429 once the per-window request cap is exceeded", async () => {
    // authLimiter caps at 100 requests / 15min per IP. Exhaust it against a
    // lightweight rate-limited endpoint, then assert the next request is
    // throttled rather than served.
    for (let i = 0; i < 100; i++) {
      // eslint-disable-next-line no-await-in-loop
      await request(app).get("/api/auth/status?email=probe@example.com");
    }
    const throttled = await request(app).get("/api/auth/status?email=probe@example.com");
    expect(throttled.status).toBe(429);
  }, 30000);
});
