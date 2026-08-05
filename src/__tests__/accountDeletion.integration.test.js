"use strict";

/**
 * Sprint 1 / B-1 — account deletion against the REAL app.
 *
 * Driven through supertest rather than by calling the handler, because the
 * properties that matter most here live OUTSIDE the controller:
 *
 *   - the route exists and is behind authMiddleware at all;
 *   - and, crucially, that a deleted account is genuinely locked out
 *     afterwards - which is a property of authMiddleware and the auth
 *     endpoints reading a users row that no longer exists, not of anything
 *     accountDeletionController does.
 *
 * That second group is why this suite deliberately does NOT use the shared
 * `activeSession` mock: that helper forces getUserSessionState() to report a
 * live session, which is exactly the thing a deleted account must not have.
 * Here the real sessionService runs against a database that returns no rows -
 * the actual post-deletion state.
 */

process.env.SUPABASE_JWT_SECRET = "test-only-secret-never-used-in-production";
process.env.ADMIN_JWT_SECRET = "test-only-admin-secret-never-used-in-production";

jest.mock("../config/db", () => ({ query: jest.fn(), pool: { connect: jest.fn() } }));
jest.mock("../config/supabase", () => ({
  storage: { from: jest.fn(() => ({ remove: jest.fn().mockResolvedValue({ error: null }) })) },
}));
jest.mock("../utils/sendEmail", () => jest.fn());
jest.mock("../services/accountDeletionService", () => ({ deleteAccount: jest.fn() }));

const request = require("supertest");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");

const db = require("../config/db");
const app = require("../app");
const accountDeletionService = require("../services/accountDeletionService");
const { accountActionLimiter, loginLimiter, refreshLimiter, statusPollLimiter } =
  require("../middleware/rateLimiters");

const USER_ID = "11111111-2222-3333-4444-555555555555";
const EMAIL = "gone@example.com";
const PASSWORD = "Str0ng!pass";

let passwordHash;

function accessToken(overrides = {}) {
  return jwt.sign(
    {
      sub: USER_ID,
      email: EMAIL,
      aud: "authenticated",
      type: "access",
      token_version: 0,
      ...overrides,
    },
    process.env.SUPABASE_JWT_SECRET,
    { algorithm: "HS256", expiresIn: "5m" }
  );
}

function refreshTokenFor() {
  return jwt.sign({ sub: USER_ID, type: "refresh", token_version: 0 }, process.env.SUPABASE_JWT_SECRET, {
    algorithm: "HS256",
    expiresIn: "30d",
  });
}

/** The database as it looks once the account is gone: nothing matches. */
function deletedAccountDb() {
  db.query.mockResolvedValue({ rows: [], rowCount: 0 });
}

/** A live account that still exists. */
function liveAccountDb() {
  db.query.mockResolvedValue({
    rows: [
      {
        id: USER_ID,
        email: EMAIL,
        provider: "local",
        password_hash: passwordHash,
        token_version: 0,
        status: "active",
        email_verified: true,
      },
    ],
    rowCount: 1,
  });
}

beforeAll(async () => {
  passwordHash = await bcrypt.hash(PASSWORD, 10);
});

beforeEach(() => {
  jest.clearAllMocks();
  [accountActionLimiter, loginLimiter, refreshLimiter, statusPollLimiter].forEach((l) => {
    l.resetKey(USER_ID);
    l.resetKey("::ffff:127.0.0.1");
    l.resetKey("127.0.0.1");
  });
  accountDeletionService.deleteAccount.mockResolvedValue({
    deleted: true,
    creationsDeleted: 0,
    storageObjectsDeleted: 0,
    storageErasureComplete: true,
  });
});

describe("the endpoint is authenticated", () => {
  it("refuses an unauthenticated caller with 401 and never touches the service", async () => {
    const res = await request(app)
      .post("/api/auth/delete-account")
      .send({ confirmation: "DELETE", currentPassword: PASSWORD });

    expect(res.status).toBe(401);
    expect(accountDeletionService.deleteAccount).not.toHaveBeenCalled();
  });

  it("refuses a token signed with the wrong secret", async () => {
    const forged = jwt.sign(
      { sub: USER_ID, aud: "authenticated", type: "access" },
      "not-the-real-secret",
      { algorithm: "HS256", expiresIn: "5m" }
    );

    const res = await request(app)
      .post("/api/auth/delete-account")
      .set("Authorization", `Bearer ${forged}`)
      .send({ confirmation: "DELETE", currentPassword: PASSWORD });

    expect(res.status).toBe(401);
    expect(accountDeletionService.deleteAccount).not.toHaveBeenCalled();
  });

  it("refuses a refresh token presented as an access token", async () => {
    const res = await request(app)
      .post("/api/auth/delete-account")
      .set("Authorization", `Bearer ${refreshTokenFor()}`)
      .send({ confirmation: "DELETE", currentPassword: PASSWORD });

    expect(res.status).toBe(401);
    expect(accountDeletionService.deleteAccount).not.toHaveBeenCalled();
  });

  it("deletes for a properly authenticated caller", async () => {
    liveAccountDb();

    const res = await request(app)
      .post("/api/auth/delete-account")
      .set("Authorization", `Bearer ${accessToken()}`)
      .send({ confirmation: "DELETE", currentPassword: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ deleted: true });
    expect(accountDeletionService.deleteAccount).toHaveBeenCalledWith(USER_ID);
  });
});

describe("after deletion the account is locked out", () => {
  // Every case below runs against a database that returns no rows for this
  // user - the real state immediately after the DELETE commits.

  it("an already-issued access token stops working at once", async () => {
    deletedAccountDb();

    const res = await request(app)
      .get("/api/creations")
      .set("Authorization", `Bearer ${accessToken()}`);

    // getUserSessionState() finds no row -> authMiddleware refuses. This is the
    // whole session-revocation mechanism: no denylist, no expiry to wait for.
    expect(res.status).toBe(401);
  });

  it("login is refused", async () => {
    deletedAccountDb();

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: EMAIL, password: PASSWORD });

    expect(res.status).toBe(401);
    // And it must not distinguish "deleted" from "never existed" - that would
    // turn deletion into an account-enumeration oracle.
    expect(JSON.stringify(res.body)).not.toMatch(/deleted|removed|erased/i);
  });

  it("refresh is refused", async () => {
    deletedAccountDb();

    const res = await request(app)
      .post("/api/auth/refresh")
      .send({ refreshToken: refreshTokenFor() });

    expect(res.status).toBe(401);
  });

  it("verification status reports unverified rather than confirming the account existed", async () => {
    deletedAccountDb();

    const res = await request(app).get("/api/auth/status").query({ email: EMAIL });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ verified: false });
  });

  it("the deletion endpoint itself is unreachable once the token is dead", async () => {
    deletedAccountDb();

    const res = await request(app)
      .post("/api/auth/delete-account")
      .set("Authorization", `Bearer ${accessToken()}`)
      .send({ confirmation: "DELETE", currentPassword: PASSWORD });

    // Repeated deletion is therefore stopped one layer earlier than the
    // controller's own idempotency guard - which remains as the race backstop.
    expect(res.status).toBe(401);
    expect(accountDeletionService.deleteAccount).not.toHaveBeenCalled();
  });
});

describe("request shape", () => {
  it("rejects a missing confirmation with 400", async () => {
    liveAccountDb();

    const res = await request(app)
      .post("/api/auth/delete-account")
      .set("Authorization", `Bearer ${accessToken()}`)
      .send({ currentPassword: PASSWORD });

    expect(res.status).toBe(400);
    expect(accountDeletionService.deleteAccount).not.toHaveBeenCalled();
  });

  it("rejects a wrong password with 403", async () => {
    liveAccountDb();

    const res = await request(app)
      .post("/api/auth/delete-account")
      .set("Authorization", `Bearer ${accessToken()}`)
      .send({ confirmation: "DELETE", currentPassword: "not-the-password" });

    expect(res.status).toBe(403);
    expect(accountDeletionService.deleteAccount).not.toHaveBeenCalled();
  });

  it("returns a 500 that says the account is unchanged when erasure fails", async () => {
    liveAccountDb();
    accountDeletionService.deleteAccount.mockRejectedValue(new Error("db exploded"));

    const res = await request(app)
      .post("/api/auth/delete-account")
      .set("Authorization", `Bearer ${accessToken()}`)
      .send({ confirmation: "DELETE", currentPassword: PASSWORD });

    expect(res.status).toBe(500);
    expect(res.body.message).toMatch(/has not been changed/i);
    expect(res.body.message).not.toMatch(/db exploded/);
  });
});
