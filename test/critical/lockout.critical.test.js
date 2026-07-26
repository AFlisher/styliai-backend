/**
 * Critical SEC-1.3 suite: per-account login lockout lifecycle, end-to-end.
 *
 * Drives the real Express app over HTTP (Supertest) with only the storage
 * layer faked. Lives in its own file so its 8 login requests get a fresh
 * loginLimiter store (10/15min per IP) instead of sharing the budget of the
 * other auth suites.
 */

require("./setupEnv");

jest.mock("../../src/config/db", () => require("./fakeDb"));
jest.mock("../../src/config/supabase", () => ({ storage: { from: () => ({}) } }));
jest.mock("../../src/utils/sendEmail", () => jest.fn().mockResolvedValue());

const bcrypt = require("bcrypt");
const request = require("supertest");

const app = require("../../src/app");
const fakeDb = require("./fakeDb");

const STRONG = "Str0ng!pass";
const EMAIL = "lock@example.com";

const attempt = (password) =>
  request(app).post("/api/auth/login").send({ email: EMAIL, password });

beforeEach(() => {
  fakeDb.reset();
  jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  console.warn.mockRestore();
});

describe("SEC-1.3 — account lockout lifecycle", () => {
  it("locks after 5 failures, rejects the correct password generically while locked, and grants a fresh budget after expiry", async () => {
    const passwordHash = await bcrypt.hash(STRONG, 10);
    fakeDb.seedUser({ id: "lk1", email: EMAIL, password_hash: passwordHash, email_verified: true });
    const user = fakeDb.state.users.find((u) => u.id === "lk1");

    // 5 wrong passwords: counter climbs, lock lands exactly at the threshold.
    for (let i = 1; i <= 5; i++) {
      const res = await attempt("Wr0ng!pass");
      expect(res.status).toBe(401);
      expect(res.body.message).toBe("Invalid email or password.");
    }
    expect(user.failed_login_attempts).toBe(5);
    expect(user.locked_until).not.toBeNull();
    expect(new Date(user.locked_until) > new Date()).toBe(true);

    // While locked, even the CORRECT password gets the same generic 401 and
    // the counter does not move (probes can't extend the lock).
    const lockedRes = await attempt(STRONG);
    expect(lockedRes.status).toBe(401);
    expect(lockedRes.body.message).toBe("Invalid email or password.");
    expect(lockedRes.body.accessToken).toBeUndefined();
    expect(user.failed_login_attempts).toBe(5);

    // Expire the lock: the next failure gets a FRESH budget (count = 1,
    // lock cleared) instead of instantly re-locking at >= 5.
    user.locked_until = new Date(Date.now() - 1000).toISOString();
    const postExpiryFail = await attempt("Wr0ng!pass");
    expect(postExpiryFail.status).toBe(401);
    expect(user.failed_login_attempts).toBe(1);
    expect(user.locked_until).toBeNull();

    // Correct password now succeeds and restores the full budget.
    const success = await attempt(STRONG);
    expect(success.status).toBe(200);
    expect(success.body.accessToken).toBeDefined();
    expect(user.failed_login_attempts).toBe(0);
    expect(user.locked_until).toBeNull();
  });
});
