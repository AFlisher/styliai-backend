/**
 * Phase 6 — Revocation & Enforcement (SEC-1.4, SEC-1.5, SEC-1.6, SEC-15.3,
 * SEC-18.2, and the token_version mechanism).
 *
 * This suite is the one place the Phase 6 controls are proved against REAL
 * session state. It deliberately does NOT use test/mocks/activeSession: every
 * other suite mocks the session read so its own assertions stay in focus, and
 * if this file did the same the controls would be proving themselves against
 * their own stub.
 *
 * Drives the real Express app over HTTP with only storage and email faked.
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
const sessionService = require("../../src/services/sessionService");

const sha256 = (v) => crypto.createHash("sha256").update(v).digest("hex");
const SECRET = process.env.SUPABASE_JWT_SECRET;
const STRONG = "Str0ng!pass";

const accessToken = (sub, claims = {}) =>
  jwt.sign(
    { sub, email: "u@example.com", role: "authenticated", aud: "authenticated", type: "access", ...claims },
    SECRET,
    { expiresIn: "1h" }
  );

const refreshJwt = (sub) => jwt.sign({ sub, type: "refresh" }, SECRET, { expiresIn: "14d" });

function seedRefreshRow(overrides) {
  const row = {
    token_hash: null,
    user_id: null,
    family_id: "fam-1",
    expires_at: new Date(Date.now() + 14 * 86400000).toISOString(),
    used_at: null,
    revoked_at: null,
    revoked_reason: null,
    ...overrides,
  };
  fakeDb.state.refreshTokens.push(row);
  return row;
}

beforeEach(() => fakeDb.reset());

// =====================================================================
// token_version — global session revocation
// =====================================================================
describe("token_version — global session revocation", () => {
  it("accepts a token whose epoch matches the stored version", async () => {
    fakeDb.seedUser({ id: "tv1", email: "tv1@x.com", email_verified: true, token_version: 4 });

    const res = await request(app)
      .get("/api/creations")
      .set("Authorization", `Bearer ${accessToken("tv1", { tv: 4 })}`);

    expect(res.status).not.toBe(401);
  });

  it("refuses every outstanding token the instant the epoch is bumped", async () => {
    const user = fakeDb.seedUser({ id: "tv2", email: "tv2@x.com", email_verified: true, token_version: 0 });
    const token = accessToken("tv2", { tv: 0 });

    // Works before...
    expect((await request(app).get("/api/creations").set("Authorization", `Bearer ${token}`)).status)
      .not.toBe(401);

    // ...and is dead immediately after, with no waiting for `exp`. This is the
    // property that makes force-logout, password change and suspension real
    // rather than "effective within the hour".
    user.token_version = 1;

    const after = await request(app).get("/api/creations").set("Authorization", `Bearer ${token}`);
    expect(after.status).toBe(401);
    expect(after.body.code).toBe("SESSION_REVOKED");
  });

  it("treats a missing tv claim as epoch 0 so pre-Phase-6 tokens survive the deploy", async () => {
    fakeDb.seedUser({ id: "tv3", email: "tv3@x.com", email_verified: true, token_version: 0 });
    // No tv claim at all - exactly what every token issued before this phase
    // looks like.
    const res = await request(app)
      .get("/api/creations")
      .set("Authorization", `Bearer ${accessToken("tv3")}`);

    expect(res.status).not.toBe(401);
  });

  it("stops grandfathering a legacy token once that user's epoch moves", async () => {
    fakeDb.seedUser({ id: "tv4", email: "tv4@x.com", email_verified: true, token_version: 2 });

    const res = await request(app)
      .get("/api/creations")
      .set("Authorization", `Bearer ${accessToken("tv4")}`);

    expect(res.status).toBe(401);
  });
});

// =====================================================================
// Force logout everywhere
// =====================================================================
describe("POST /api/auth/logout-all — force logout everywhere", () => {
  it("bumps the epoch, revokes every family, and kills the calling session too", async () => {
    const user = fakeDb.seedUser({ id: "la1", email: "la1@x.com", email_verified: true, token_version: 0 });
    seedRefreshRow({ token_hash: "hash-a", user_id: "la1", family_id: "fam-a" });
    seedRefreshRow({ token_hash: "hash-b", user_id: "la1", family_id: "fam-b" });

    const token = accessToken("la1", { tv: 0 });
    const res = await request(app).post("/api/auth/logout-all").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(204);

    expect(user.token_version).toBe(1);
    // Every family, not just the caller's - "everywhere" means everywhere.
    expect(fakeDb.state.refreshTokens.filter((r) => r.revoked_at !== null)).toHaveLength(2);

    // The token that made the call is now dead as well. That is intended: you
    // asked to be signed out everywhere, and this device is somewhere.
    const after = await request(app).get("/api/creations").set("Authorization", `Bearer ${token}`);
    expect(after.status).toBe(401);
  });

  it("plain logout revokes refresh tokens WITHOUT bumping the epoch (per-device)", async () => {
    const user = fakeDb.seedUser({ id: "lo1", email: "lo1@x.com", email_verified: true, token_version: 0 });
    seedRefreshRow({ token_hash: "hash-c", user_id: "lo1" });

    const res = await request(app)
      .post("/api/auth/logout")
      .set("Authorization", `Bearer ${accessToken("lo1", { tv: 0 })}`);
    expect(res.status).toBe(204);

    // A bump here would sign the user out of every other device too, which is
    // surprising behaviour for a button labelled "log out".
    expect(user.token_version).toBe(0);
    expect(fakeDb.state.refreshTokens[0].revoked_at).not.toBeNull();
  });
});

// =====================================================================
// SEC-1.4 — refresh reuse detection and family revocation
// =====================================================================
describe("SEC-1.4 — refresh token reuse detection", () => {
  it("rotates a valid token and keeps the successor in the same family", async () => {
    fakeDb.seedUser({ id: "rt1", email: "rt1@x.com", email_verified: true, token_version: 0 });
    const rt = refreshJwt("rt1");
    seedRefreshRow({ token_hash: sha256(rt), user_id: "rt1", family_id: "fam-1" });

    const res = await request(app).post("/api/auth/refresh").send({ refreshToken: rt });
    expect(res.status).toBe(200);

    const old = fakeDb.state.refreshTokens.find((r) => r.token_hash === sha256(rt));
    expect(old.used_at).not.toBeNull();

    const next = fakeDb.state.refreshTokens.find((r) => r.token_hash === sha256(res.body.refreshToken));
    expect(next.family_id).toBe("fam-1");
    expect(next.used_at).toBeNull();
  });

  it("detects reuse of an already-exchanged token and revokes the WHOLE family", async () => {
    // The scenario: a thief copies a refresh token. The legitimate client
    // rotates first, so the thief presents a token that has already been used.
    // Which of the two is presenting it now is unknowable, so both must go.
    const user = fakeDb.seedUser({ id: "rt2", email: "rt2@x.com", email_verified: true, token_version: 0 });
    const stolen = refreshJwt("rt2");
    seedRefreshRow({ token_hash: sha256(stolen), user_id: "rt2", family_id: "fam-x" });

    const first = await request(app).post("/api/auth/refresh").send({ refreshToken: stolen });
    expect(first.status).toBe(200);

    // The thief now replays the same token.
    const replay = await request(app).post("/api/auth/refresh").send({ refreshToken: stolen });
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe("SESSION_REVOKED");

    // Whole family gone...
    const family = fakeDb.state.refreshTokens.filter((r) => r.family_id === "fam-x");
    expect(family.every((r) => r.revoked_at !== null)).toBe(true);
    expect(family.some((r) => r.revoked_reason === "reuse_detected")).toBe(true);

    // ...AND the epoch bumped. Revoking the family alone would have left the
    // thief's freshly-minted ACCESS token working for up to an hour, which
    // would make this containment in name only.
    expect(user.token_version).toBe(1);
  });

  it("the successor issued to the victim also stops working after reuse is detected", async () => {
    fakeDb.seedUser({ id: "rt3", email: "rt3@x.com", email_verified: true, token_version: 0 });
    const original = refreshJwt("rt3");
    seedRefreshRow({ token_hash: sha256(original), user_id: "rt3", family_id: "fam-y" });

    const victim = await request(app).post("/api/auth/refresh").send({ refreshToken: original });
    const victimRefresh = victim.body.refreshToken;

    await request(app).post("/api/auth/refresh").send({ refreshToken: original }); // thief replays

    const after = await request(app).post("/api/auth/refresh").send({ refreshToken: victimRefresh });
    expect(after.status).toBe(401);
  });

  it("does NOT escalate an unrecognised token to a family revocation", async () => {
    // Otherwise anyone could deny service to an arbitrary account by posting
    // garbage: reuse means "a token we issued and already exchanged", not
    // "a token we do not recognise".
    const user = fakeDb.seedUser({ id: "rt4", email: "rt4@x.com", email_verified: true, token_version: 0 });
    seedRefreshRow({ token_hash: "someone-elses", user_id: "rt4", family_id: "fam-z" });

    const res = await request(app).post("/api/auth/refresh").send({ refreshToken: refreshJwt("rt4") });

    expect(res.status).toBe(401);
    expect(user.token_version).toBe(0);
    expect(fakeDb.state.refreshTokens[0].revoked_at).toBeNull();
  });

  it("refuses a revoked token and an expired row", async () => {
    fakeDb.seedUser({ id: "rt5", email: "rt5@x.com", email_verified: true });
    const revoked = refreshJwt("rt5");
    const expired = refreshJwt("rt5");
    seedRefreshRow({ token_hash: sha256(revoked), user_id: "rt5", revoked_at: new Date().toISOString() });
    seedRefreshRow({
      token_hash: sha256(expired),
      user_id: "rt5",
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });

    expect((await request(app).post("/api/auth/refresh").send({ refreshToken: revoked })).status).toBe(401);
    expect((await request(app).post("/api/auth/refresh").send({ refreshToken: expired })).status).toBe(401);
  });

  it("migrates a pre-Phase-6 session held only in the legacy column, exactly once", async () => {
    // Without this, deploying Phase 6 would sign out every logged-in user.
    const user = fakeDb.seedUser({ id: "rt6", email: "rt6@x.com", email_verified: true, token_version: 0 });
    const legacy = refreshJwt("rt6");
    user.refresh_token_hash = sha256(legacy);

    const first = await request(app).post("/api/auth/refresh").send({ refreshToken: legacy });
    expect(first.status).toBe(200);
    expect(user.refresh_token_hash).toBeNull();          // consumed
    expect(fakeDb.state.refreshTokens).toHaveLength(1);  // migrated into a family

    // Replaying the legacy token must not work a second time.
    const second = await request(app).post("/api/auth/refresh").send({ refreshToken: legacy });
    expect(second.status).toBe(401);
  });
});

// =====================================================================
// SEC-1.5 — email verification token expiry
// =====================================================================
describe("SEC-1.5 — verification tokens expire and are one-time", () => {
  it("accepts a token inside its window and burns it", async () => {
    const user = fakeDb.seedUser({
      id: "ev1",
      email: "ev1@x.com",
      verification_token_hash: sha256("tok-1"),
      verification_token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
    });

    const res = await request(app).get("/api/auth/verify?token=tok-1");
    expect(res.status).toBe(200);
    expect(user.email_verified).toBe(true);
    expect(user.verification_token_hash).toBeNull();
  });

  it("rejects an expired token — the finding: these never expired at all", async () => {
    const user = fakeDb.seedUser({
      id: "ev2",
      email: "ev2@x.com",
      verification_token_hash: sha256("tok-2"),
      verification_token_expires_at: new Date(Date.now() - 1000).toISOString(),
    });

    const res = await request(app).get("/api/auth/verify?token=tok-2");
    expect(res.status).toBe(400);
    expect(user.email_verified).toBe(false);
  });

  it("rejects a replay of an already-used token", async () => {
    fakeDb.seedUser({
      id: "ev3",
      email: "ev3@x.com",
      verification_token_hash: sha256("tok-3"),
      verification_token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
    });

    expect((await request(app).get("/api/auth/verify?token=tok-3")).status).toBe(200);
    expect((await request(app).get("/api/auth/verify?token=tok-3")).status).toBe(400);
  });

  it("fails closed on a NULL expiry rather than resurrecting unbounded links", async () => {
    fakeDb.seedUser({
      id: "ev4",
      email: "ev4@x.com",
      verification_token_hash: sha256("tok-4"),
      verification_token_expires_at: null,
    });

    expect((await request(app).get("/api/auth/verify?token=tok-4")).status).toBe(400);
  });

  it("register and resend both write an expiry", async () => {
    await request(app)
      .post("/api/auth/register")
      .send({ email: "ev5@x.com", password: STRONG, fullName: "E" });
    const registered = fakeDb.state.users.find((u) => u.email === "ev5@x.com");
    expect(registered.verification_token_expires_at).toBeTruthy();

    registered.verification_token_expires_at = null;
    await request(app).post("/api/auth/resend-verification").send({ email: "ev5@x.com" });
    expect(registered.verification_token_expires_at).toBeTruthy();
  });
});

// =====================================================================
// SEC-1.6 — bcrypt cost 12 with transparent upgrade
// =====================================================================
describe("SEC-1.6 — bcrypt cost 12", () => {
  it("hashes new registrations at cost 12", async () => {
    await request(app)
      .post("/api/auth/register")
      .send({ email: "bc1@x.com", password: STRONG, fullName: "B" });

    const user = fakeDb.state.users.find((u) => u.email === "bc1@x.com");
    expect(user.password_hash).toMatch(/^\$2b\$12\$/);
  });

  it("upgrades a legacy cost-10 hash on successful login, without breaking the user", async () => {
    const legacy = await bcrypt.hash(STRONG, 10);
    const user = fakeDb.seedUser({
      id: "bc2", email: "bc2@x.com", email_verified: true, password_hash: legacy, provider: "email",
    });
    expect(user.password_hash).toMatch(/^\$2b\$10\$/);

    const res = await request(app).post("/api/auth/login").send({ email: "bc2@x.com", password: STRONG });
    expect(res.status).toBe(200);

    // Rehashed at the only moment the plaintext legitimately exists...
    expect(user.password_hash).toMatch(/^\$2b\$12\$/);
    // ...and still the same password.
    expect(await bcrypt.compare(STRONG, user.password_hash)).toBe(true);

    const again = await request(app).post("/api/auth/login").send({ email: "bc2@x.com", password: STRONG });
    expect(again.status).toBe(200);
  });

  it("leaves an already cost-12 hash untouched", async () => {
    const current = await bcrypt.hash(STRONG, 12);
    const user = fakeDb.seedUser({
      id: "bc3", email: "bc3@x.com", email_verified: true, password_hash: current, provider: "email",
    });

    await request(app).post("/api/auth/login").send({ email: "bc3@x.com", password: STRONG });
    expect(user.password_hash).toBe(current);
  });
});

// =====================================================================
// Password change / reset invalidate access tokens
// =====================================================================
describe("password change and reset end other sessions", () => {
  it("change-password revokes other devices' ACCESS tokens but keeps this one", async () => {
    const currentHash = await bcrypt.hash("OldPass1!", 10);
    const user = fakeDb.seedUser({
      id: "pc1", email: "pc1@x.com", provider: "email", password_hash: currentHash, token_version: 0,
    });
    const otherDevice = accessToken("pc1", { tv: 0 });

    const res = await request(app)
      .post("/api/auth/change-password")
      .set("Authorization", `Bearer ${otherDevice}`)
      .send({ currentPassword: "OldPass1!", newPassword: STRONG });
    expect(res.status).toBe(200);
    expect(user.token_version).toBe(1);

    // The device that changed the password keeps working, on its new token...
    const withNew = await request(app)
      .get("/api/creations")
      .set("Authorization", `Bearer ${res.body.accessToken}`);
    expect(withNew.status).not.toBe(401);

    // ...every other device is out, immediately rather than within the hour.
    const withOld = await request(app).get("/api/creations").set("Authorization", `Bearer ${otherDevice}`);
    expect(withOld.status).toBe(401);
  });

  it("password reset is one-time, expiry-checked, and revokes everything", async () => {
    const user = fakeDb.seedUser({
      id: "pr1",
      email: "pr1@x.com",
      reset_token_hash: sha256("11111111-2222-4333-8444-555555555555"),
      reset_token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
      token_version: 0,
    });
    seedRefreshRow({ token_hash: "rr-1", user_id: "pr1" });
    const live = accessToken("pr1", { tv: 0 });

    const res = await request(app)
      .post("/api/auth/reset-password")
      .type("form")
      .send({ token: "11111111-2222-4333-8444-555555555555", password: STRONG });
    expect(res.status).toBe(200);

    expect(user.token_version).toBe(1);
    expect(fakeDb.state.refreshTokens[0].revoked_at).not.toBeNull();
    // An attacker's live access token dies with the old password rather than
    // outliving the reset by up to an hour.
    expect((await request(app).get("/api/creations").set("Authorization", `Bearer ${live}`)).status).toBe(401);

    // Replay of the same link finds nothing to match.
    const replay = await request(app)
      .post("/api/auth/reset-password")
      .type("form")
      .send({ token: "11111111-2222-4333-8444-555555555555", password: "An0ther!pass" });
    expect(replay.status).toBe(400);
  });

  it("rejects an expired reset link", async () => {
    fakeDb.seedUser({
      id: "pr2",
      email: "pr2@x.com",
      reset_token_hash: sha256("22222222-2222-4333-8444-555555555555"),
      reset_token_expires_at: new Date(Date.now() - 1000).toISOString(),
    });

    const res = await request(app)
      .post("/api/auth/reset-password")
      .type("form")
      .send({ token: "22222222-2222-4333-8444-555555555555", password: STRONG });
    expect(res.status).toBe(400);
  });
});

// =====================================================================
// SEC-18.2 — suspension enforced mid-session
// =====================================================================
describe("SEC-18.2 — user suspension", () => {
  const adminToken = () =>
    jwt.sign(
      { sub: "admin-1", email: "a@x.com", role: "admin", adminRole: "superadmin", tv: 0 },
      process.env.ADMIN_JWT_SECRET,
      { algorithm: "HS256", expiresIn: "2h" }
    );

  it("stops a running session on its NEXT request, not at next login", async () => {
    const user = fakeDb.seedUser({ id: "aaaaaaaa-1111-4111-8111-111111111111", email: "sp1@x.com", email_verified: true, token_version: 0 });
    fakeDb.seedAdmin({ id: "admin-1", email: "a@x.com", token_version: 0 });
    const live = accessToken("aaaaaaaa-1111-4111-8111-111111111111", { tv: 0 });

    expect((await request(app).get("/api/creations").set("Authorization", `Bearer ${live}`)).status)
      .not.toBe(401);

    const res = await request(app)
      .post("/api/admin/users/aaaaaaaa-1111-4111-8111-111111111111/suspend")
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({ reason: "abuse" });
    expect(res.status).toBe(200);
    expect(user.status).toBe("suspended");

    const after = await request(app).get("/api/creations").set("Authorization", `Bearer ${live}`);
    expect(after.status).toBe(403);
    expect(after.body.code).toBe("ACCOUNT_SUSPENDED");
  });

  it("blocks login and refresh for a suspended account", async () => {
    const hash = await bcrypt.hash(STRONG, 12);
    fakeDb.seedUser({
      id: "sp2", email: "sp2@x.com", email_verified: true, password_hash: hash,
      provider: "email", status: "suspended",
    });
    const rt = refreshJwt("sp2");
    seedRefreshRow({ token_hash: sha256(rt), user_id: "sp2" });

    const login = await request(app).post("/api/auth/login").send({ email: "sp2@x.com", password: STRONG });
    expect(login.status).toBe(403);
    expect(login.body.code).toBe("ACCOUNT_SUSPENDED");

    const refresh = await request(app).post("/api/auth/refresh").send({ refreshToken: rt });
    expect(refresh.status).toBe(403);
  });

  it("suspension revokes refresh families so nothing can mint a replacement", async () => {
    fakeDb.seedUser({ id: "cccccccc-3333-4333-8333-333333333333", email: "sp3@x.com", email_verified: true });
    fakeDb.seedAdmin({ id: "admin-1", email: "a@x.com", token_version: 0 });
    seedRefreshRow({ token_hash: "sp3-rt", user_id: "cccccccc-3333-4333-8333-333333333333" });

    await request(app)
      .post("/api/admin/users/cccccccc-3333-4333-8333-333333333333/suspend")
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({});

    expect(fakeDb.state.refreshTokens[0].revoked_at).not.toBeNull();
  });

  it("reinstates an account, and the old tokens still do not work", async () => {
    const user = fakeDb.seedUser({
      id: "dddddddd-4444-4444-8444-444444444444", email: "sp4@x.com", email_verified: true, status: "suspended", token_version: 1,
    });
    fakeDb.seedAdmin({ id: "admin-1", email: "a@x.com", token_version: 0 });
    const preSuspension = accessToken("dddddddd-4444-4444-8444-444444444444", { tv: 1 });

    const res = await request(app)
      .post("/api/admin/users/dddddddd-4444-4444-8444-444444444444/reinstate")
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({});
    expect(res.status).toBe(200);
    expect(user.status).toBe("active");

    // One rule - any status change ends existing sessions - rather than two.
    expect((await request(app).get("/api/creations").set("Authorization", `Bearer ${preSuspension}`)).status)
      .toBe(401);
  });

  it("rejects an unknown status and a non-existent user", async () => {
    fakeDb.seedAdmin({ id: "admin-1", email: "a@x.com", token_version: 0 });

    const bad = await request(app)
      .post("/api/admin/users/11111111-1111-4111-8111-111111111111/suspend")
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({ status: "deleted" });
    expect(bad.status).toBe(400);

    const missing = await request(app)
      .post("/api/admin/users/11111111-1111-4111-8111-111111111111/suspend")
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({});
    expect(missing.status).toBe(404);
  });
});

// =====================================================================
// sessionService unit-level semantics
// =====================================================================
describe("sessionService.consumeRefreshToken outcomes", () => {
  it("distinguishes consumed / reuse / revoked / expired / unknown", async () => {
    fakeDb.seedUser({ id: "cs1", email: "cs1@x.com" });

    seedRefreshRow({ token_hash: sha256("good"), user_id: "cs1" });
    seedRefreshRow({ token_hash: sha256("used"), user_id: "cs1", used_at: new Date().toISOString() });
    seedRefreshRow({ token_hash: sha256("gone"), user_id: "cs1", revoked_at: new Date().toISOString() });
    seedRefreshRow({
      token_hash: sha256("old"), user_id: "cs1",
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });

    expect((await sessionService.consumeRefreshToken("good")).outcome).toBe("consumed");
    expect((await sessionService.consumeRefreshToken("used")).outcome).toBe("reuse");
    expect((await sessionService.consumeRefreshToken("gone")).outcome).toBe("revoked");
    expect((await sessionService.consumeRefreshToken("old")).outcome).toBe("expired");
    expect((await sessionService.consumeRefreshToken("never")).outcome).toBe("unknown");

    // Consuming is single-shot: the token that just succeeded now reports reuse.
    expect((await sessionService.consumeRefreshToken("good")).outcome).toBe("reuse");
  });

  it("reports reuse for a token that was used and later revoked", async () => {
    // Not 'revoked': the revocation was very likely triggered BY the first
    // reuse, and reporting it as a plain revocation would hide a repeat
    // attempt from the security log.
    fakeDb.seedUser({ id: "cs2", email: "cs2@x.com" });
    seedRefreshRow({
      token_hash: sha256("both"), user_id: "cs2",
      used_at: new Date().toISOString(), revoked_at: new Date().toISOString(),
    });

    expect((await sessionService.consumeRefreshToken("both")).outcome).toBe("reuse");
  });
});
