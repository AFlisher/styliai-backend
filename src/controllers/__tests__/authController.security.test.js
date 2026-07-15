// Covers the security-audit fixes in authController:
//  #2  password reset/change revokes the stored refresh token
//  #6  verification tokens are stored as SHA-256 hashes
//  #8  the shared password policy applies to register & change-password
//  #11 Google-only accounts (NULL password_hash) get a clean 401 on login,
//      and Google tokens without an email claim get a clean 401

process.env.GOOGLE_WEB_CLIENT_ID = "test-client-id";
process.env.SUPABASE_JWT_SECRET = "test-supabase-secret";

jest.mock("../../config/db", () => ({
  query: jest.fn(),
  pool: { connect: jest.fn() },
}));
jest.mock("../../utils/sendEmail", () => jest.fn());

const mockVerifyIdToken = jest.fn();
jest.mock("google-auth-library", () => ({
  OAuth2Client: jest.fn().mockImplementation(() => ({
    verifyIdToken: mockVerifyIdToken,
  })),
}));

const crypto = require("crypto");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const db = require("../../config/db");
const sendEmail = require("../../utils/sendEmail");
const { PASSWORD_POLICY_MESSAGE } = require("../../utils/passwordPolicy");
const {
  register,
  verifyEmail,
  login,
  postResetPassword,
  changePassword,
  googleSignIn,
  resendVerification,
} = require("../authController");

const sha256 = (v) => crypto.createHash("sha256").update(v).digest("hex");
const HEX64 = /^[0-9a-f]{64}$/;
const STRONG_PASSWORD = "Str0ng!pass";

function makeRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
    send: jest.fn(),
  };
}

beforeEach(() => {
  // resetAllMocks (not clearAllMocks) so unconsumed mockResolvedValueOnce
  // queues from a test that exited early can't leak into the next test.
  jest.resetAllMocks();
});

describe("register (findings #6, #8)", () => {
  it("rejects a password that fails the shared policy with a 400, before touching the DB", async () => {
    const req = { body: { email: "new@example.com", password: "abc123", fullName: "New User" } };
    const res = makeRes();

    await register(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ message: PASSWORD_POLICY_MESSAGE });
    expect(db.query).not.toHaveBeenCalled();
  });

  it("stores only the SHA-256 hash of the verification token, never the raw UUID", async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // duplicate-email check
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() };
    db.pool.connect.mockResolvedValueOnce(client);
    sendEmail.mockResolvedValueOnce();

    const req = { body: { email: "new@example.com", password: STRONG_PASSWORD, fullName: "New User" } };
    const res = makeRes();

    await register(req, res);

    expect(res.status).toHaveBeenCalledWith(201);

    const insertCall = client.query.mock.calls.find(([sql]) => sql.includes("INSERT INTO public.users"));
    expect(insertCall[0]).toContain("verification_token_hash");
    const storedToken = insertCall[1][4];
    expect(storedToken).toMatch(HEX64);

    // The link emailed to the user carries the raw token; its hash must be
    // exactly what was stored.
    const emailedToken = sendEmail.mock.calls[0][0].html.match(/verify\?token=([0-9a-f-]{36})/)[1];
    expect(sha256(emailedToken)).toBe(storedToken);
  });
});

describe("verifyEmail (finding #6)", () => {
  it("looks the user up by the hash of the presented token", async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: "user-1", email_verified: false }] })
      .mockResolvedValueOnce({ rows: [] });

    const rawToken = "11111111-2222-3333-4444-555555555555";
    const res = makeRes();

    await verifyEmail({ query: { token: rawToken } }, res);

    expect(db.query.mock.calls[0][0]).toContain("verification_token_hash = $1");
    expect(db.query.mock.calls[0][1]).toEqual([sha256(rawToken)]);
    expect(db.query.mock.calls[1][0]).toContain("verification_token_hash = NULL");
  });
});

describe("resendVerification (finding #6)", () => {
  it("issues a fresh token and stores only its hash", async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: "user-1", full_name: "User", email_verified: false }] })
      .mockResolvedValueOnce({ rows: [] }); // UPDATE hash
    sendEmail.mockResolvedValueOnce();

    const res = makeRes();
    await resendVerification({ body: { email: "user@example.com" } }, res);

    const updateCall = db.query.mock.calls[1];
    expect(updateCall[0]).toContain("verification_token_hash = $1");
    expect(updateCall[1][0]).toMatch(HEX64);

    const emailedToken = sendEmail.mock.calls[0][0].html.match(/verify\?token=([0-9a-f-]{36})/)[1];
    expect(sha256(emailedToken)).toBe(updateCall[1][0]);
  });
});

describe("login (finding #11)", () => {
  it("returns a generic 401 for a Google-only account with no password hash instead of a 500", async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: "user-1", email: "g@example.com", full_name: "G", password_hash: null, email_verified: true }],
    });
    const res = makeRes();

    await login({ body: { email: "g@example.com", password: "whatever" } }, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ message: "Invalid email or password." });
  });
});

describe("postResetPassword (finding #2)", () => {
  it("revokes the stored refresh token in the same UPDATE that sets the new password", async () => {
    const future = new Date(Date.now() + 3600 * 1000).toISOString();
    db.query
      .mockResolvedValueOnce({ rows: [{ id: "user-1", reset_token_expires_at: future }] })
      .mockResolvedValueOnce({ rows: [] }); // UPDATE

    const res = makeRes();
    await postResetPassword(
      { body: { token: "11111111-2222-4333-8444-555555555555", password: STRONG_PASSWORD } },
      res
    );

    const updateCall = db.query.mock.calls[1];
    expect(updateCall[0]).toContain("refresh_token_hash = NULL");
    expect(res.send).toHaveBeenCalled(); // success page rendered
  });
});

describe("changePassword (findings #2, #8)", () => {
  it("rejects a weak new password with the shared policy message", async () => {
    const res = makeRes();
    await changePassword(
      { user: { id: "user-1" }, body: { currentPassword: "old", newPassword: "short1!" } },
      res
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ message: PASSWORD_POLICY_MESSAGE });
    expect(db.query).not.toHaveBeenCalled();
  });

  it("rotates the refresh token (revoking other sessions) and returns a fresh, matching token pair", async () => {
    const currentHash = await bcrypt.hash("OldPass1!", 4);
    db.query
      .mockResolvedValueOnce({
        rows: [{ id: "user-1", email: "u@example.com", full_name: "U", password_hash: currentHash, provider: "email" }],
      })
      .mockResolvedValueOnce({ rows: [] }); // UPDATE

    const res = makeRes();
    await changePassword(
      { user: { id: "user-1" }, body: { currentPassword: "OldPass1!", newPassword: STRONG_PASSWORD } },
      res
    );

    const updateCall = db.query.mock.calls[1];
    expect(updateCall[0]).toContain("refresh_token_hash = $2");
    expect(updateCall[1][1]).toMatch(HEX64);

    const body = res.json.mock.calls[0][0];
    expect(body.accessToken).toBeDefined();
    expect(body.refreshToken).toBeDefined();
    // The stored hash must be the hash of the refresh token handed back to
    // this session, so this device stays logged in while others are revoked.
    expect(sha256(body.refreshToken)).toBe(updateCall[1][1]);
    expect(jwt.verify(body.refreshToken, process.env.SUPABASE_JWT_SECRET).sub).toBe("user-1");
  });
});

describe("googleSignIn (finding #11)", () => {
  it("returns 401 when the verified Google token has no email claim instead of crashing", async () => {
    mockVerifyIdToken.mockResolvedValueOnce({ getPayload: () => ({ sub: "google-123" }) });

    const res = makeRes();
    await googleSignIn({ body: { idToken: "some-token" } }, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      message: "Google account did not provide an email address.",
    });
    expect(db.query).not.toHaveBeenCalled();
  });
});
