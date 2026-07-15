/**
 * Medium-priority HTTP-contract suite (QA_TEST_PLAN.md):
 *   API-018, API-020, SEC-013, REG-010
 */

require("../critical/setupEnv");

jest.mock("../../src/config/db", () => require("../critical/fakeDb"));
jest.mock("../../src/config/supabase", () => ({ storage: { from: () => ({}) } }));

const jwt = require("jsonwebtoken");
const request = require("supertest");
const app = require("../../src/app");

describe("API-018 — unknown routes return the JSON 404 handler", () => {
  it("returns 404 with the standard body", async () => {
    const res = await request(app).get("/api/this-does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ message: "Resource not found." });
  });
});

describe("API-020 / REG-010 — security headers", () => {
  it("sets a CSP that does not allow inline scripts", async () => {
    const res = await request(app).get("/");
    const csp = res.headers["content-security-policy"];
    expect(csp).toBeDefined();
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });

  it("sets standard Helmet hardening headers", async () => {
    const res = await request(app).get("/");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-dns-prefetch-control"]).toBeDefined();
    expect(res.headers).not.toHaveProperty("x-powered-by");
  });
});

describe("SEC-013 — admin token lifetime is enforced", () => {
  it("rejects an expired admin token", async () => {
    const expired = jwt.sign({ sub: "a", role: "admin" }, process.env.ADMIN_JWT_SECRET, { expiresIn: -10 });
    const res = await request(app).get("/api/admin/stats").set("Authorization", `Bearer ${expired}`);
    expect(res.status).toBe(401);
  });

  it("accepts a freshly-minted admin token at the guard", async () => {
    // Guard-level check only: a valid, unexpired admin token must NOT be
    // rejected as unauthorized (401/403). Downstream data loading is covered
    // in adminStats.medium.test.js.
    const valid = jwt.sign({ sub: "a", role: "admin" }, process.env.ADMIN_JWT_SECRET, { expiresIn: "2h" });
    const res = await request(app).get("/api/admin/stats").set("Authorization", `Bearer ${valid}`);
    expect([401, 403]).not.toContain(res.status);
  });
});
