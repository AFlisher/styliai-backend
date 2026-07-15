/**
 * Critical injection-resilience suite (QA_TEST_PLAN.md):
 *   SEC-002 (SQL injection)
 *
 * Every backend query is parameterized ($1, $2, ...), so user input can only
 * ever be bound as data, never concatenated into SQL. These tests assert the
 * app-layer contract that adversarial input is handled gracefully - rejected
 * with a validation/auth status, never a 500 and never an auth bypass.
 */

require("./setupEnv");

jest.mock("../../src/config/db", () => require("./fakeDb"));
jest.mock("../../src/config/supabase", () => ({ storage: { from: () => ({}) } }));
jest.mock("../../src/utils/sendEmail", () => jest.fn().mockResolvedValue());

const bcrypt = require("bcrypt");
const request = require("supertest");
const app = require("../../src/app");
const fakeDb = require("./fakeDb");

const SQLI = [
  "' OR '1'='1",
  "'; DROP TABLE users; --",
  "admin'--",
  "\" OR \"\"=\"",
  "1'; UPDATE users SET balance=999999; --",
];

beforeEach(() => fakeDb.reset());

describe("SEC-002 — login is not bypassable via SQL injection", () => {
  it.each(SQLI)("rejects injection payload in the email field: %s", async (payload) => {
    // A real, valid account exists - the payload must not authenticate as it.
    const passwordHash = await bcrypt.hash("Str0ng!pass", 10);
    fakeDb.seedUser({ id: "victim", email: "victim@example.com", password_hash: passwordHash, email_verified: true });

    const res = await request(app).post("/api/auth/login").send({ email: payload, password: "anything" });

    // Either 400 (fails email-format validation) or 401 (no match) - never a
    // 200 bypass and never a 500 crash.
    expect([400, 401]).toContain(res.status);
    expect(res.body.accessToken).toBeUndefined();
  });
});

describe("SEC-002 — injection payloads in other inputs are treated as data", () => {
  it.each(SQLI)("handles injection in the password field without bypass: %s", async (payload) => {
    const passwordHash = await bcrypt.hash("Str0ng!pass", 10);
    fakeDb.seedUser({ id: "victim2", email: "victim2@example.com", password_hash: passwordHash, email_verified: true });

    const res = await request(app).post("/api/auth/login").send({ email: "victim2@example.com", password: payload });

    expect(res.status).toBe(401);
    expect(res.body.accessToken).toBeUndefined();
  });

  it("stores an injection payload in fullName as inert data on register", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ email: "reg@example.com", password: "Str0ng!pass", fullName: "Robert'); DROP TABLE users; --" });

    expect(res.status).toBe(201);
    // The account was created and the payload persisted verbatim (as data),
    // with the rest of the users table intact.
    const user = fakeDb.state.users.find((u) => u.email === "reg@example.com");
    expect(user).toBeDefined();
    expect(user.full_name).toContain("DROP TABLE");
  });

  it("does not 500 on an injection payload in the verification-status email query", async () => {
    const res = await request(app).get(`/api/auth/status?email=${encodeURIComponent("' OR 1=1 --")}`);
    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(false);
  });
});
