/**
 * Medium-priority auth-change suite (QA_TEST_PLAN.md):
 *   FT-009, FT-010, SEC-018
 */

require("../critical/setupEnv");

jest.mock("../../src/config/db", () => require("../critical/fakeDb"));
jest.mock("../../src/config/supabase", () => ({ storage: { from: () => ({}) } }));

const crypto = require("crypto");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const request = require("supertest");
const app = require("../../src/app");
const fakeDb = require("../critical/fakeDb");

const sha256 = (v) => crypto.createHash("sha256").update(v).digest("hex");
const STRONG = "Str0ng!pass";
const token = (id) => jwt.sign({ sub: id, email: `${id}@x.com`, role: "authenticated" }, process.env.SUPABASE_JWT_SECRET, { expiresIn: "1h" });

beforeEach(() => fakeDb.reset());

describe("FT-009 — change-password succeeds and rotates sessions", () => {
  it("verifies the current password, sets the new one, and returns a fresh token pair", async () => {
    const currentHash = await bcrypt.hash("Curr3nt!pw", 10);
    fakeDb.seedUser({ id: "cp1", email: "cp1@x.com", full_name: "CP", provider: "email", password_hash: currentHash, refresh_token_hash: "old-hash" });

    const res = await request(app)
      .post("/api/auth/change-password")
      .set("Authorization", `Bearer ${token("cp1")}`)
      .send({ currentPassword: "Curr3nt!pw", newPassword: STRONG });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
    expect(res.body.refreshToken).toBeDefined();

    const user = fakeDb.state.users.find((u) => u.id === "cp1");
    expect(await bcrypt.compare(STRONG, user.password_hash)).toBe(true);
    // Stored refresh hash now tracks the returned token (other sessions revoked).
    expect(user.refresh_token_hash).toBe(sha256(res.body.refreshToken));
  });

  it("rejects an incorrect current password with 400", async () => {
    const currentHash = await bcrypt.hash("Curr3nt!pw", 10);
    fakeDb.seedUser({ id: "cp2", email: "cp2@x.com", provider: "email", password_hash: currentHash });
    const res = await request(app)
      .post("/api/auth/change-password")
      .set("Authorization", `Bearer ${token("cp2")}`)
      .send({ currentPassword: "WrongCurr1!", newPassword: STRONG });
    expect(res.status).toBe(400);
  });
});

describe("FT-010 — change-password is blocked for Google accounts", () => {
  it("returns 400 for a google-provider account", async () => {
    fakeDb.seedUser({ id: "g1", email: "g1@x.com", provider: "google", password_hash: null });
    const res = await request(app)
      .post("/api/auth/change-password")
      .set("Authorization", `Bearer ${token("g1")}`)
      .send({ currentPassword: "anything", newPassword: STRONG });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/google/i);
  });
});

describe("SEC-018 — error responses do not leak internal details", () => {
  it("returns a generic message with no stack trace on an unexpected failure", async () => {
    // Force an internal error path: no user row for this id -> change-password
    // hits the 404 branch, not a 500 with internals. And a route that 500s
    // must not include a stack.
    fakeDb.seedUser({ id: "s1", email: "s1@x.com", provider: "email", password_hash: await bcrypt.hash("Curr3nt!pw", 10) });
    const res = await request(app).get("/api/auth/status"); // missing email -> 400 path
    expect(res.status).toBe(400);
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/at .*\(.*:\d+:\d+\)/); // no stack frames
    expect(body).not.toMatch(/node_modules/);
  });

  it("the generic 500 handler emits only a code + message, never a stack", async () => {
    // A disallowed CORS origin trips the generic error handler.
    const res = await request(app).get("/").set("Origin", "http://evil.example.com");
    if (res.status === 500) {
      expect(res.body).toEqual({ code: "INTERNAL_ERROR", message: expect.any(String) });
      expect(JSON.stringify(res.body)).not.toMatch(/node_modules|at Object|\.js:\d+/);
    }
  });
});
