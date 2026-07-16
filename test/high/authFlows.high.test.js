/**
 * High-priority auth-flow suite (QA_TEST_PLAN.md):
 *   FT-007, API-004, FT-008, API-007, SEC-005, SEC-006, SEC-008, SEC-010
 */

require("../critical/setupEnv");

jest.mock("../../src/config/db", () => require("../critical/fakeDb"));
jest.mock("../../src/config/supabase", () => ({ storage: { from: () => ({}) } }));
jest.mock("../../src/utils/sendEmail", () => jest.fn().mockResolvedValue());

const mockVerifyIdToken = jest.fn();
jest.mock("google-auth-library", () => ({
  OAuth2Client: jest.fn().mockImplementation(() => ({ verifyIdToken: mockVerifyIdToken })),
}));

const crypto = require("crypto");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const request = require("supertest");

const app = require("../../src/app");
const fakeDb = require("../critical/fakeDb");
const sendEmail = require("../../src/utils/sendEmail");

const sha256 = (v) => crypto.createHash("sha256").update(v).digest("hex");
const STRONG = "Str0ng!pass";
const HEX64 = /^[0-9a-f]{64}$/;

beforeEach(() => {
  fakeDb.reset();
  sendEmail.mockClear();
  mockVerifyIdToken.mockReset();
});

describe("FT-007 — Google sign-in", () => {
  it("creates a new account and issues a session for a first-time Google user", async () => {
    mockVerifyIdToken.mockResolvedValue({
      getPayload: () => ({ sub: "google-123", email: "gnew@example.com", name: "G New", picture: "http://a/x.png" }),
    });

    const res = await request(app).post("/api/auth/google").send({ idToken: "valid-token" });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
    expect(res.body.user.email).toBe("gnew@example.com");
    const user = fakeDb.state.users.find((u) => u.email === "gnew@example.com");
    expect(user.provider).toBe("google");
    expect(user.email_verified).toBe(true);
  });

  it("links Google to an existing email account and logs in", async () => {
    fakeDb.seedUser({ id: "e1", email: "link@example.com", provider: "email", email_verified: true, password_hash: "x" });
    mockVerifyIdToken.mockResolvedValue({
      getPayload: () => ({ sub: "google-999", email: "link@example.com", name: "Linked" }),
    });

    const res = await request(app).post("/api/auth/google").send({ idToken: "valid-token" });

    expect(res.status).toBe(200);
    const user = fakeDb.state.users.find((u) => u.email === "link@example.com");
    expect(user.google_id).toBe("google-999");
  });

  it("rejects an invalid Google ID token", async () => {
    mockVerifyIdToken.mockRejectedValue(new Error("bad token"));
    const res = await request(app).post("/api/auth/google").send({ idToken: "bad" });
    expect(res.status).toBe(401);
  });
});

describe("API-004 — Google-only account cannot log in with a password", () => {
  it("returns a generic 401 instead of a 500 when password_hash is null", async () => {
    fakeDb.seedUser({ id: "g-only", email: "gonly@example.com", provider: "google", password_hash: null, email_verified: true });
    const res = await request(app).post("/api/auth/login").send({ email: "gonly@example.com", password: STRONG });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe("Invalid email or password.");
  });
});

describe("FT-008 / SEC-005 — forgot-password flow stores a hashed token", () => {
  it("emails a reset link, stores only the token hash, and completes the reset", async () => {
    const oldHash = await bcrypt.hash("Old1!pass", 10);
    fakeDb.seedUser({ id: "fp1", email: "fp@example.com", email_verified: true, provider: "email", password_hash: oldHash });

    const forgot = await request(app).post("/api/auth/forgot-password").send({ email: "fp@example.com" });
    expect(forgot.status).toBe(200);
    expect(sendEmail).toHaveBeenCalledTimes(1);

    const user = fakeDb.state.users.find((u) => u.id === "fp1");
    expect(user.reset_token_hash).toMatch(HEX64); // SEC-005: hashed at rest

    const rawToken = sendEmail.mock.calls[0][0].html.match(/reset-password\?token=([0-9a-f-]{36})/)[1];
    expect(sha256(rawToken)).toBe(user.reset_token_hash);

    // The GET renders the form, the POST applies the new password.
    const form = await request(app).get(`/api/auth/reset-password?token=${rawToken}`);
    expect(form.status).toBe(200);

    const done = await request(app).post("/api/auth/reset-password").type("form").send({ token: rawToken, password: STRONG });
    expect(done.status).toBe(200);
    expect(await bcrypt.compare(STRONG, user.password_hash)).toBe(true);
  });
});

describe("API-007 / SEC-008 — auth endpoints don't enable account enumeration", () => {
  it("forgot-password responds identically for existing and unknown emails", async () => {
    fakeDb.seedUser({ id: "en1", email: "exists@example.com", email_verified: true, provider: "email" });
    const known = await request(app).post("/api/auth/forgot-password").send({ email: "exists@example.com" });
    const unknown = await request(app).post("/api/auth/forgot-password").send({ email: "missing@example.com" });
    expect(known.status).toBe(unknown.status);
    expect(known.body).toEqual(unknown.body);
  });

  it("verification-status reports unverified for unknown accounts (no distinct 404)", async () => {
    fakeDb.seedUser({ id: "en2", email: "unv@example.com", email_verified: false });
    const unknown = await request(app).get("/api/auth/status?email=nobody@example.com");
    const unverified = await request(app).get("/api/auth/status?email=unv@example.com");
    expect(unknown.status).toBe(200);
    expect(unknown.body).toEqual({ verified: false });
    expect(unverified.body).toEqual({ verified: false });
  });

  it("resend-verification responds identically regardless of account state", async () => {
    fakeDb.seedUser({ id: "en3", email: "verified@example.com", email_verified: true });
    const known = await request(app).post("/api/auth/resend-verification").send({ email: "verified@example.com" });
    const unknown = await request(app).post("/api/auth/resend-verification").send({ email: "nobody2@example.com" });
    expect(known.status).toBe(unknown.status);
    expect(known.body).toEqual(unknown.body);
  });
});

describe("SEC-006 — the password policy is enforced across every flow", () => {
  it("register rejects a weak password", async () => {
    const res = await request(app).post("/api/auth/register").send({ email: "w1@example.com", password: "weak", fullName: "W" });
    expect(res.status).toBe(400);
  });

  it("change-password rejects a weak new password", async () => {
    const token = jwt.sign({ sub: "cp1", email: "cp@example.com", role: "authenticated" }, process.env.SUPABASE_JWT_SECRET, { expiresIn: "1h" });
    const res = await request(app)
      .post("/api/auth/change-password")
      .set("Authorization", `Bearer ${token}`)
      .send({ currentPassword: "Old1!pass", newPassword: "weak" });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/at least 8 characters/i);
  });

  it("reset-password rejects a weak new password", async () => {
    const rawToken = "22222222-3333-4333-8444-666666666666";
    fakeDb.seedUser({
      id: "rp1",
      email: "rp@example.com",
      reset_token_hash: sha256(rawToken),
      reset_token_expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    });
    const res = await request(app).post("/api/auth/reset-password").type("form").send({ token: rawToken, password: "weak" });
    expect(res.status).toBe(400);
  });
});

describe("SEC-010 — user-supplied names are HTML-escaped in emails", () => {
  it("escapes a script payload in fullName in the verification email", async () => {
    await request(app)
      .post("/api/auth/register")
      .send({ email: "xss@example.com", password: STRONG, fullName: "<script>alert(document.cookie)</script>" });

    const html = sendEmail.mock.calls[0][0].html;
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert");
  });
});
