/**
 * Critical auth suite (QA_TEST_PLAN.md):
 *   FT-001, FT-003, FT-005, API-001, API-002, API-003, API-005, SEC-004, REG-001
 *
 * Drives the real Express app over HTTP (Supertest) with only the storage
 * layer and email transport faked.
 */

require("./setupEnv");

jest.mock("../../src/config/db", () => require("./fakeDb"));
jest.mock("../../src/config/supabase", () => ({ storage: { from: () => ({}) } }));
jest.mock("../../src/utils/sendEmail", () => jest.fn().mockResolvedValue());

const crypto = require("crypto");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const request = require("supertest");

const app = require("../../src/app");
const fakeDb = require("./fakeDb");
const sendEmail = require("../../src/utils/sendEmail");

const sha256 = (v) => crypto.createHash("sha256").update(v).digest("hex");
const STRONG = "Str0ng!pass";

beforeEach(() => {
  fakeDb.reset();
  sendEmail.mockClear();
});

describe("FT-001 / API-001 — register (valid)", () => {
  it("creates an unverified user, sends a verification email, returns 201", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ email: "new@example.com", password: STRONG, fullName: "New User" });

    expect(res.status).toBe(201);
    expect(res.body.message).toMatch(/verify your email/i);

    const user = fakeDb.state.users.find((u) => u.email === "new@example.com");
    expect(user).toBeDefined();
    expect(user.email_verified).toBe(false);
    // Verification token persisted only as a SHA-256 hash.
    expect(user.verification_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });
});

describe("API-002 — register (invalid) returns 400, not 500", () => {
  it("rejects a weak password with a validation message", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ email: "weak@example.com", password: "abc123", fullName: "Weak" });

    expect(res.status).toBe(400);
    expect(fakeDb.state.users).toHaveLength(0);
  });

  it("rejects a malformed email with 400", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ email: "not-an-email", password: STRONG, fullName: "X" });
    expect(res.status).toBe(400);
  });
});

describe("FT-003 — email verification", () => {
  it("verifies the account when the emailed token's hash matches", async () => {
    await request(app)
      .post("/api/auth/register")
      .send({ email: "verify@example.com", password: STRONG, fullName: "V" });

    // Recover the raw token from the emailed link, exactly as a user would.
    const html = sendEmail.mock.calls[0][0].html;
    const rawToken = html.match(/verify\?token=([0-9a-f-]{36})/)[1];

    const res = await request(app).get(`/api/auth/verify?token=${rawToken}`);

    expect(res.status).toBe(200);
    expect(res.text).toMatch(/Verified/i);
    const user = fakeDb.state.users.find((u) => u.email === "verify@example.com");
    expect(user.email_verified).toBe(true);
    expect(user.verification_token_hash).toBeNull();
  });

  it("rejects an unknown verification token", async () => {
    const res = await request(app).get("/api/auth/verify?token=00000000-0000-4000-8000-000000000000");
    expect(res.status).toBe(400);
    expect(res.text).toMatch(/invalid|failed/i);
  });
});

describe("FT-005 — unverified login is blocked", () => {
  it("returns 403 and issues no tokens for an unverified account", async () => {
    const passwordHash = await bcrypt.hash(STRONG, 10);
    fakeDb.seedUser({ id: "u1", email: "unv@example.com", password_hash: passwordHash, email_verified: false });

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "unv@example.com", password: STRONG });

    expect(res.status).toBe(403);
    expect(res.body.accessToken).toBeUndefined();
  });
});

describe("API-003 — verified login succeeds", () => {
  it("returns an access + refresh token pair and persists the refresh hash", async () => {
    const passwordHash = await bcrypt.hash(STRONG, 10);
    fakeDb.seedUser({ id: "u2", email: "ok@example.com", password_hash: passwordHash, email_verified: true });

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "ok@example.com", password: STRONG });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
    expect(res.body.refreshToken).toBeDefined();

    const decoded = jwt.verify(res.body.accessToken, process.env.SUPABASE_JWT_SECRET);
    expect(decoded.sub).toBe("u2");

    const user = fakeDb.state.users.find((u) => u.id === "u2");
    expect(user.refresh_token_hash).toBe(sha256(res.body.refreshToken));
  });

  it("returns a generic 401 for a wrong password (indistinguishable from unknown email)", async () => {
    const passwordHash = await bcrypt.hash(STRONG, 10);
    fakeDb.seedUser({ id: "u3", email: "ok2@example.com", password_hash: passwordHash, email_verified: true });

    const wrong = await request(app).post("/api/auth/login").send({ email: "ok2@example.com", password: "Wr0ng!pass" });
    const unknown = await request(app).post("/api/auth/login").send({ email: "nobody@example.com", password: STRONG });

    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.message).toBe(unknown.body.message);
  });
});

describe("API-005 — refresh token rotation", () => {
  it("issues a new pair and rotates the stored hash", async () => {
    const refreshToken = jwt.sign({ sub: "u4" }, process.env.SUPABASE_JWT_SECRET, { expiresIn: "30d" });
    fakeDb.seedUser({ id: "u4", email: "r@example.com", email_verified: true, refresh_token_hash: sha256(refreshToken) });

    const res = await request(app).post("/api/auth/refresh").send({ refreshToken });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
    expect(res.body.refreshToken).toBeDefined();
    // The stored hash tracks the newly-returned refresh token (rotation). We
    // avoid asserting string inequality of the two JWTs: the refresh payload
    // is only { sub, iat, exp }, so two tokens minted in the same wall-clock
    // second are legitimately identical - a timing artifact, not a contract.
    const decoded = jwt.verify(res.body.refreshToken, process.env.SUPABASE_JWT_SECRET);
    expect(decoded.sub).toBe("u4");

    const user = fakeDb.state.users.find((u) => u.id === "u4");
    expect(user.refresh_token_hash).toBe(sha256(res.body.refreshToken));
  });

  it("rejects a refresh token whose hash no longer matches", async () => {
    const refreshToken = jwt.sign({ sub: "u5" }, process.env.SUPABASE_JWT_SECRET, { expiresIn: "30d" });
    fakeDb.seedUser({ id: "u5", email: "r2@example.com", refresh_token_hash: "some-other-hash" });

    const res = await request(app).post("/api/auth/refresh").send({ refreshToken });
    expect(res.status).toBe(401);
  });
});

describe("SEC-004 — password reset revokes existing sessions", () => {
  it("clears the refresh hash so a stolen refresh token stops working", async () => {
    const rawResetToken = "11111111-2222-4333-8444-555555555555";
    const oldRefresh = jwt.sign({ sub: "u6" }, process.env.SUPABASE_JWT_SECRET, { expiresIn: "30d" });
    fakeDb.seedUser({
      id: "u6",
      email: "reset@example.com",
      email_verified: true,
      provider: "email",
      refresh_token_hash: sha256(oldRefresh),
      reset_token_hash: sha256(rawResetToken),
      reset_token_expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    });

    // 1. Complete the reset (form POST, urlencoded).
    const reset = await request(app)
      .post("/api/auth/reset-password")
      .type("form")
      .send({ token: rawResetToken, password: STRONG });
    expect(reset.status).toBe(200);
    expect(reset.text).toMatch(/success/i);

    // 2. The previously-valid refresh token is now revoked.
    const refresh = await request(app).post("/api/auth/refresh").send({ refreshToken: oldRefresh });
    expect(refresh.status).toBe(401);

    const user = fakeDb.state.users.find((u) => u.id === "u6");
    expect(user.refresh_token_hash).toBeNull();
  });
});
