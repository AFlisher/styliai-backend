/**
 * Critical admin-authorization suite (QA_TEST_PLAN.md):
 *   API-008, API-009, SEC-001
 *
 * Verifies every admin-only write is blocked without a valid admin token,
 * that a mobile user's (Supabase-signed) token is NOT accepted as admin, and
 * that a correctly-signed admin token reaches the handler.
 */

require("./setupEnv");

jest.mock("../../src/config/db", () => require("./fakeDb"));
jest.mock("../../src/config/supabase", () => ({ storage: { from: () => ({}) } }));
// Isolate the createStyle happy path from the persistence + tagging layers so
// the assertion is purely "valid admin token is authorized and reaches the
// controller".
jest.mock("../../src/models/styleModel", () => ({
  createStyle: jest.fn().mockResolvedValue({ id: "style-1", name: "Created" }),
}));
jest.mock("../../src/services/recommendationService", () => ({
  invalidateCandidateCache: jest.fn(),
  getSimilarStyles: jest.fn(),
}));

const jwt = require("jsonwebtoken");
const request = require("supertest");
const app = require("../../src/app");

const adminToken = () =>
  jwt.sign({ sub: "admin-1", email: "a@x.com", role: "admin" }, process.env.ADMIN_JWT_SECRET, { expiresIn: "2h" });

// A legitimate mobile-user token: correctly signed, but with the Supabase
// secret and role "authenticated" - must never satisfy the admin guard.
const userToken = () =>
  jwt.sign({ sub: "user-1", email: "u@x.com", role: "authenticated" }, process.env.SUPABASE_JWT_SECRET, { expiresIn: "1h" });

const WRITE_ENDPOINTS = [
  ["post", "/api/styles"],
  ["put", "/api/styles/00000000-0000-4000-8000-000000000000"],
  ["delete", "/api/styles/00000000-0000-4000-8000-000000000000"],
  ["post", "/api/categories"],
  ["put", "/api/categories/00000000-0000-4000-8000-000000000000"],
  ["delete", "/api/categories/00000000-0000-4000-8000-000000000000"],
  ["post", "/api/tags"],
  ["post", "/api/credit-packs"],
  ["post", "/api/upload"],
];

describe("API-008 / SEC-001 — admin writes require a valid admin token", () => {
  it.each(WRITE_ENDPOINTS)("blocks %s %s with no token", async (method, path) => {
    const res = await request(app)[method](path).send({});
    expect([401, 403]).toContain(res.status);
  });

  it.each(WRITE_ENDPOINTS)("rejects %s %s presented with a mobile-user token", async (method, path) => {
    const res = await request(app)[method](path).set("Authorization", `Bearer ${userToken()}`).send({});
    expect([401, 403]).toContain(res.status);
  });

  it("rejects a token signed with the wrong secret", async () => {
    const forged = jwt.sign({ sub: "x", role: "admin" }, "not-the-admin-secret", { expiresIn: "2h" });
    const res = await request(app).post("/api/styles").set("Authorization", `Bearer ${forged}`).send({});
    expect(res.status).toBe(401);
  });

  it("rejects a valid-secret token whose role is not admin", async () => {
    const nonAdmin = jwt.sign({ sub: "x", role: "user" }, process.env.ADMIN_JWT_SECRET, { expiresIn: "2h" });
    const res = await request(app).post("/api/styles").set("Authorization", `Bearer ${nonAdmin}`).send({});
    expect(res.status).toBe(403);
  });
});

describe("API-009 — valid admin token is authorized", () => {
  it("reaches the handler and creates a style (201)", async () => {
    const res = await request(app)
      .post("/api/styles")
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({ categoryId: "cat-1", name: "Cyberpunk", prompt: "a neon city", autoAssignTags: false });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("style-1");
  });

  it("still enforces input validation behind the guard (missing name -> 400)", async () => {
    const res = await request(app)
      .post("/api/styles")
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({ categoryId: "cat-1", prompt: "x", autoAssignTags: false });
    expect(res.status).toBe(400);
  });
});
