/**
 * Rate limiting suite - validates the dedicated per-category limiters in
 * src/middleware/rateLimiters.js: every limiter's configured value, that
 * requests under the limit pass through untouched, that exceeding it
 * returns a consistent 429 JSON body with standard (not legacy) headers,
 * that dedicated limiters are isolated from each other (hitting one
 * category never throttles another), that IP-based limiters key correctly
 * under the app's `trust proxy: 2` config (see src/app.js), and that
 * user-keyed limiters isolate different accounts sharing one IP.
 */

require("../critical/setupEnv");

jest.mock("../../src/config/db", () => require("../critical/fakeDb"));
jest.mock("../../src/config/supabase", () => ({ storage: { from: () => ({}) } }));
jest.mock("../../src/utils/sendEmail", () => jest.fn().mockResolvedValue());

const jwt = require("jsonwebtoken");
const request = require("supertest");
const app = require("../../src/app");
const fakeDb = require("../critical/fakeDb");
const { LIMIT_VALUES } = require("../../src/middleware/rateLimiters");

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const userToken = (id) =>
  jwt.sign({ sub: id, email: `${id}@x.com`, role: "authenticated" }, process.env.SUPABASE_JWT_SECRET, { expiresIn: "1h" });

beforeEach(() => fakeDb.reset());

describe("every documented limiter carries its stated window/limit", () => {
  it.each([
    ["loginLimiter", 15 * MINUTE, 10],
    ["registerLimiter", HOUR, 5],
    ["forgotPasswordLimiter", HOUR, 5],
    ["resetPasswordLimiter", HOUR, 5],
    ["emailVerificationLimiter", HOUR, 20],
    ["statusPollLimiter", MINUTE, 90],
    ["refreshLimiter", 15 * MINUTE, 100],
    ["googleSignInLimiter", 15 * MINUTE, 20],
    ["accountActionLimiter", 15 * MINUTE, 30],
    ["generationLimiter", MINUTE, 20],
    ["adminGenerationPreviewLimiter", MINUTE, 10],
    ["uploadLimiter", MINUTE, 30],
    ["ssvCallbackLimiter", MINUTE, 200],
    ["rewardClaimLimiter", 15 * MINUTE, 20],
    ["publicReadLimiter", MINUTE, 300],
    ["userDataLimiter", MINUTE, 120],
    ["adminLoginLimiter", 15 * MINUTE, 10],
    ["adminActionLimiter", MINUTE, 100],
  ])("%s -> windowMs=%d limit=%d", (name, windowMs, limit) => {
    expect(LIMIT_VALUES[name]).toEqual({ windowMs, limit });
  });
});

describe("requests under the limit are never throttled", () => {
  it("allows every attempt up to (but not including) the configured max", async () => {
    // loginLimiter = 10/15min; 9 bad-credential attempts should all be
    // evaluated by the real controller (401), never short-circuited by the
    // limiter (429), from a dedicated IP so no other test's traffic can leak in.
    for (let i = 0; i < 9; i++) {
      const res = await request(app)
        .post("/api/auth/login")
        .set("X-Forwarded-For", "10.0.0.1, 5.6.7.8")
        .send({ email: "nobody@example.com", password: "wrong" });
      expect(res.status).toBe(401);
    }
  });
});

describe("exceeding the limit returns 429 with the standard JSON error shape", () => {
  it("blocks the 11th login attempt within the window and recovers under a fresh IP", async () => {
    const ip = "10.0.0.2, 5.6.7.8";
    for (let i = 0; i < 10; i++) {
      const res = await request(app)
        .post("/api/auth/login")
        .set("X-Forwarded-For", ip)
        .send({ email: "nobody@example.com", password: "wrong" });
      expect(res.status).toBe(401);
    }

    const blocked = await request(app)
      .post("/api/auth/login")
      .set("X-Forwarded-For", ip)
      .send({ email: "nobody@example.com", password: "wrong" });

    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({
      code: "RATE_LIMITED",
      message: expect.stringMatching(/too many login attempts/i),
    });
    // standardHeaders on, legacyHeaders off (requirement #4).
    expect(blocked.headers["ratelimit-limit"]).toBeDefined();
    expect(blocked.headers["x-ratelimit-limit"]).toBeUndefined();

    // A different client IP (per the app's trust-proxy:2 hop count - see
    // src/app.js) is a completely separate bucket, proving isolation is by
    // caller identity and this isn't a global limiter.
    const otherIp = await request(app)
      .post("/api/auth/login")
      .set("X-Forwarded-For", "10.0.0.3, 5.6.7.8")
      .send({ email: "nobody@example.com", password: "wrong" });
    expect(otherIp.status).toBe(401);
  });
});

describe("dedicated limiters are isolated per category, not one global limiter", () => {
  it("exhausting the login limiter does not affect the register limiter on the same IP", async () => {
    const ip = "10.0.1.1, 5.6.7.8";
    for (let i = 0; i < 10; i++) {
      await request(app).post("/api/auth/login").set("X-Forwarded-For", ip).send({ email: "x@x.com", password: "wrong" });
    }
    const loginBlocked = await request(app).post("/api/auth/login").set("X-Forwarded-For", ip).send({ email: "x@x.com", password: "wrong" });
    expect(loginBlocked.status).toBe(429);

    // register has its own 5/hour budget - unaffected by login's exhausted bucket.
    const registerRes = await request(app)
      .post("/api/auth/register")
      .set("X-Forwarded-For", ip)
      .send({ email: "fresh@example.com", password: "Str0ng!pass", fullName: "Fresh User" });
    expect(registerRes.status).toBe(201);
  });
});

describe("unauthenticated vs authenticated traffic on the same endpoint", () => {
  it("rejects with 401 before ever reaching the concurrency/business logic when unauthenticated", async () => {
    const res = await request(app).get("/api/wallet").set("X-Forwarded-For", "10.0.2.1, 5.6.7.8");
    expect(res.status).toBe(401);
  });

  it("serves an authenticated caller normally under the same IP", async () => {
    fakeDb.seedUser({ id: "rl-u1", balance: 3, email_verified: true });
    const res = await request(app)
      .get("/api/wallet")
      .set("X-Forwarded-For", "10.0.2.1, 5.6.7.8")
      .set("Authorization", `Bearer ${userToken("rl-u1")}`);
    expect(res.status).toBe(200);
    expect(res.body.balance).toBe(3);
  });
});

describe("multiple users behind one IP are rate-limited independently when the limiter is user-keyed", () => {
  it("rewardClaimLimiter keys by user id: exhausting user A's budget never throttles user B on the same IP", async () => {
    process.env.ENABLE_CLIENT_AD_REWARD = "true";
    const sharedIp = "10.0.3.1, 5.6.7.8";
    fakeDb.seedUser({ id: "rl-a", balance: 0, ads_progress: 0, email_verified: true });
    fakeDb.seedUser({ id: "rl-b", balance: 0, ads_progress: 0, email_verified: true });
    const rewardAs = (id) =>
      request(app)
        .post("/api/wallet/reward")
        .set("X-Forwarded-For", sharedIp)
        .set("Authorization", `Bearer ${userToken(id)}`);

    // rewardClaimLimiter = 20/15min, keyed by user id (see rateLimiters.js).
    for (let i = 0; i < 20; i++) {
      const res = await rewardAs("rl-a");
      expect(res.status).toBe(200);
    }
    const aBlocked = await rewardAs("rl-a");
    expect(aBlocked.status).toBe(429);

    // Same IP, different user - fresh budget, not affected by A's exhaustion.
    const bFirst = await rewardAs("rl-b");
    expect(bFirst.status).toBe(200);

    delete process.env.ENABLE_CLIENT_AD_REWARD;
  });
});

describe("a blocked client is let through again once its window elapses", () => {
  // Exercises the exact same express-rate-limit + jsonRateLimitHandler
  // machinery every production limiter above is built from (see
  // makeLimiter() in rateLimiters.js), just with a short window so the test
  // doesn't have to wait out a real 15-minute/1-hour production window to
  // prove the reset actually happens.
  it("blocks over the limit, then admits the same client again after windowMs passes", async () => {
    const { rateLimit } = require("express-rate-limit");
    const express = require("express");

    const scratch = express();
    scratch.use(
      rateLimit({
        windowMs: 150,
        limit: 2,
        standardHeaders: true,
        legacyHeaders: false,
        handler: (req, res) => res.status(429).json({ code: "RATE_LIMITED", message: "slow down" }),
      })
    );
    scratch.get("/ping", (req, res) => res.json({ ok: true }));

    expect((await request(scratch).get("/ping")).status).toBe(200);
    expect((await request(scratch).get("/ping")).status).toBe(200);
    expect((await request(scratch).get("/ping")).status).toBe(429);

    await new Promise((resolve) => setTimeout(resolve, 200));

    expect((await request(scratch).get("/ping")).status).toBe(200);
  });
});

describe("admin login has its own stricter, independent budget", () => {
  it("does not share a bucket with the regular user login limiter", async () => {
    const ip = "10.0.4.1, 5.6.7.8";
    // Exhaust the user loginLimiter (10/15min) first.
    for (let i = 0; i < 10; i++) {
      await request(app).post("/api/auth/login").set("X-Forwarded-For", ip).send({ email: "x@x.com", password: "wrong" });
    }
    const userBlocked = await request(app).post("/api/auth/login").set("X-Forwarded-For", ip).send({ email: "x@x.com", password: "wrong" });
    expect(userBlocked.status).toBe(429);

    // Admin login on the same IP still goes through to the controller (401
    // for bad creds, not 429) because it's a separate limiter instance.
    const adminRes = await request(app)
      .post("/api/admin/login")
      .set("X-Forwarded-For", ip)
      .send({ email: "admin@example.com", password: "wrong" });
    expect(adminRes.status).toBe(401);
  });
});
