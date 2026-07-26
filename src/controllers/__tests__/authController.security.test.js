// Covers the security-audit fixes in authController:
//  #2  password reset/change revokes the stored refresh token
//  #6  verification tokens are stored as SHA-256 hashes
//  #8  the shared password policy applies to register & change-password
//  #11 Google-only accounts (NULL password_hash) get a clean 401 on login,
//      and Google tokens without an email claim get a clean 401
//  SEC-1.1 token-type discrimination: access tokens carry aud/type:'access',
//      refresh tokens carry type:'refresh' and no aud; /refresh rejects an
//      access token but keeps accepting legacy (pre-SEC-1.1) refresh tokens
//  SEC-1.2 login timing equalization: non-existent and Google-only accounts
//      burn a dummy bcrypt compare at the same cost as real user hashes so
//      response timing can't enumerate registered emails
//  SEC-1.3 per-account lockout: failed logins are counted atomically, the
//      account locks at the threshold, a locked account answers the same
//      dummy-compare 401 as every other rejection, and success/reset/expiry
//      restore the attempt budget

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
  refreshToken,
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

describe("login timing equalization (SEC-1.2)", () => {
  it("runs a dummy bcrypt compare at cost 10 for a non-existent email, then answers the generic 401", async () => {
    const compareSpy = jest.spyOn(bcrypt, "compare");
    try {
      db.query.mockResolvedValueOnce({ rows: [] });
      const res = makeRes();

      await login({ body: { email: "nobody@example.com", password: "whatever" } }, res);

      expect(compareSpy).toHaveBeenCalledTimes(1);
      // The dummy must carry the same cost factor (10) as the bcrypt.hash
      // calls in this controller, or the timing gap reopens.
      expect(compareSpy.mock.calls[0][1]).toMatch(/^\$2b\$10\$/);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ message: "Invalid email or password." });
    } finally {
      compareSpy.mockRestore();
    }
  });

  it("runs the same dummy bcrypt compare for a Google-only account (no password hash)", async () => {
    const compareSpy = jest.spyOn(bcrypt, "compare");
    try {
      db.query.mockResolvedValueOnce({
        rows: [{ id: "user-1", email: "g@example.com", full_name: "G", password_hash: null, email_verified: true }],
      });
      const res = makeRes();

      await login({ body: { email: "g@example.com", password: "whatever" } }, res);

      expect(compareSpy).toHaveBeenCalledTimes(1);
      expect(compareSpy.mock.calls[0][1]).toMatch(/^\$2b\$10\$/);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ message: "Invalid email or password." });
    } finally {
      compareSpy.mockRestore();
    }
  });
});

describe("login lockout (SEC-1.3)", () => {
  it("rejects a locked account with the generic 401 + dummy compare, without touching the counter or the real hash", async () => {
    const compareSpy = jest.spyOn(bcrypt, "compare");
    try {
      db.query.mockResolvedValueOnce({
        rows: [{ id: "user-1", email: "u@example.com", full_name: "U", password_hash: "$2b$10$realhash", email_verified: true, is_locked: true }],
      });
      const res = makeRes();

      await login({ body: { email: "u@example.com", password: "whatever" } }, res);

      // Only the dummy is ever compared while locked - never the real hash.
      expect(compareSpy).toHaveBeenCalledTimes(1);
      expect(compareSpy.mock.calls[0][1]).toMatch(/^\$2b\$10\$/);
      expect(compareSpy.mock.calls[0][1]).not.toBe("$2b$10$realhash");
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ message: "Invalid email or password." });
      // No failure UPDATE: probes during a lock don't extend it.
      expect(db.query).toHaveBeenCalledTimes(1);
    } finally {
      compareSpy.mockRestore();
    }
  });

  it("records a wrong password via the single atomic CASE update", async () => {
    const realHash = await bcrypt.hash("Right1!pass", 4);
    db.query
      .mockResolvedValueOnce({
        rows: [{ id: "user-1", email: "u@example.com", full_name: "U", password_hash: realHash, email_verified: true, is_locked: false }],
      })
      .mockResolvedValueOnce({ rows: [{ failed_login_attempts: 1, locked_until: null }] });
    const res = makeRes();

    await login({ body: { email: "u@example.com", password: "Wr0ng!pass" } }, res);

    const updateCall = db.query.mock.calls[1];
    expect(updateCall[0]).toContain("failed_login_attempts = CASE");
    expect(updateCall[0]).toContain("RETURNING failed_login_attempts, locked_until");
    expect(updateCall[1]).toEqual(["user-1"]);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ message: "Invalid email or password." });
  });

  it("warns (id only, no email) when the failure threshold locks the account", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const realHash = await bcrypt.hash("Right1!pass", 4);
      db.query
        .mockResolvedValueOnce({
          rows: [{ id: "user-1", email: "u@example.com", full_name: "U", password_hash: realHash, email_verified: true, is_locked: false }],
        })
        .mockResolvedValueOnce({
          rows: [{ failed_login_attempts: 5, locked_until: new Date(Date.now() + 15 * 60 * 1000).toISOString() }],
        });
      const res = makeRes();

      await login({ body: { email: "u@example.com", password: "Wr0ng!pass" } }, res);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain("user-1");
      expect(warnSpy.mock.calls[0][0]).not.toContain("u@example.com");
      expect(res.status).toHaveBeenCalledWith(401);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("restores the attempt budget in the same UPDATE that stores the refresh hash on success", async () => {
    const realHash = await bcrypt.hash("Right1!pass", 4);
    db.query
      .mockResolvedValueOnce({
        rows: [{ id: "user-1", email: "u@example.com", full_name: "U", password_hash: realHash, email_verified: true, is_locked: false }],
      })
      .mockResolvedValueOnce({ rows: [] }); // refresh-hash UPDATE
    const res = makeRes();

    await login({ body: { email: "u@example.com", password: "Right1!pass" } }, res);

    const updateCall = db.query.mock.calls[1];
    expect(updateCall[0]).toContain("refresh_token_hash = $1");
    expect(updateCall[0]).toContain("failed_login_attempts = 0");
    expect(updateCall[0]).toContain("locked_until = NULL");
    expect(res.json.mock.calls[0][0].accessToken).toBeDefined();
  });

  it("clears the lockout in the password-reset UPDATE (recovery path unlocks)", async () => {
    const future = new Date(Date.now() + 3600 * 1000).toISOString();
    db.query
      .mockResolvedValueOnce({ rows: [{ id: "user-1", reset_token_expires_at: future }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = makeRes();
    await postResetPassword(
      { body: { token: "11111111-2222-4333-8444-555555555555", password: STRONG_PASSWORD } },
      res
    );

    const updateCall = db.query.mock.calls[1];
    expect(updateCall[0]).toContain("failed_login_attempts = 0");
    expect(updateCall[0]).toContain("locked_until = NULL");
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

describe("refreshToken endpoint (SEC-1.1)", () => {
  const SECRET = process.env.SUPABASE_JWT_SECRET;

  it("rejects an access token presented as a refresh token, before touching the DB", async () => {
    const accessLike = jwt.sign(
      { sub: "user-1", email: "u@example.com", role: "authenticated", aud: "authenticated", type: "access" },
      SECRET,
      { expiresIn: "1h" }
    );
    const res = makeRes();

    await refreshToken({ body: { refreshToken: accessLike } }, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ message: "Invalid or expired refresh token." });
    expect(db.query).not.toHaveBeenCalled();
  });

  it("still accepts a legacy refresh token (no type claim) whose hash matches the stored one", async () => {
    const legacyRefresh = jwt.sign({ sub: "user-1" }, SECRET, { expiresIn: "30d" });
    db.query
      .mockResolvedValueOnce({
        rows: [{ id: "user-1", email: "u@example.com", full_name: "U", refresh_token_hash: sha256(legacyRefresh) }],
      })
      .mockResolvedValueOnce({ rows: [] }); // UPDATE rotated hash

    const res = makeRes();
    await refreshToken({ body: { refreshToken: legacyRefresh } }, res);

    expect(res.status).not.toHaveBeenCalled();
    const body = res.json.mock.calls[0][0];
    // The rotated pair must carry the SEC-1.1 discriminating claims: the
    // access token keeps the Supabase claim shape plus type:'access', and the
    // refresh token declares type:'refresh' with no aud claim.
    const accessClaims = jwt.verify(body.accessToken, SECRET);
    expect(accessClaims.aud).toBe("authenticated");
    expect(accessClaims.type).toBe("access");
    const refreshClaims = jwt.verify(body.refreshToken, SECRET);
    expect(refreshClaims.type).toBe("refresh");
    expect(refreshClaims.aud).toBeUndefined();
  });

  it("rejects a rotated-out refresh token whose hash no longer matches (revocation still works)", async () => {
    const staleRefresh = jwt.sign({ sub: "user-1", type: "refresh" }, SECRET, { expiresIn: "30d" });
    db.query.mockResolvedValueOnce({
      rows: [{ id: "user-1", email: "u@example.com", full_name: "U", refresh_token_hash: sha256("a-different-token") }],
    });

    const res = makeRes();
    await refreshToken({ body: { refreshToken: staleRefresh } }, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ message: "Invalid or expired refresh token." });
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
