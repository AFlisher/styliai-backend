// SEC-15.2: the admin login sequence with a second factor.
//
// The security properties under test are ordering and disclosure, not just
// "does a good code work": a wrong password must never reveal whether an
// account has MFA enrolled, and a wrong code must cost the same lockout budget
// as a wrong password.

const crypto = require("crypto");

process.env.ADMIN_JWT_SECRET = "test-admin-secret";
process.env.MFA_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");

jest.mock("../../config/db", () => ({ query: jest.fn(), pool: { connect: jest.fn() } }));
jest.mock("../../services/wallet/walletService", () => ({}));

const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { authenticator } = require("otplib");
const db = require("../../config/db");
const { encryptSecret } = require("../../utils/mfaCrypto");
const { login } = require("../adminController");

const PASSWORD = "correct-horse-battery-staple";
const SECRET = authenticator.generateSecret();
let PASSWORD_HASH;

beforeAll(async () => {
  PASSWORD_HASH = await bcrypt.hash(PASSWORD, 4);
});

function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

function adminRow(overrides = {}) {
  return {
    id: "admin-1",
    email: "admin@example.com",
    full_name: "Test Admin",
    password_hash: PASSWORD_HASH,
    mfa_enabled: false,
    mfa_secret: null,
    mfa_last_timestep: null,
    is_locked: false,
    ...overrides,
  };
}

function mfaAdminRow(overrides = {}) {
  return adminRow({ mfa_enabled: true, mfa_secret: encryptSecret(SECRET), ...overrides });
}

/** SELECT admins -> row; every later query (failure counter, timestep) succeeds. */
function mockLookup(row) {
  db.query.mockReset();
  db.query.mockImplementation((sql) => {
    if (typeof sql === "string" && sql.includes("FROM admins")) {
      return Promise.resolve({ rows: row ? [row] : [], rowCount: row ? 1 : 0 });
    }
    return Promise.resolve({ rows: [{ failed_login_attempts: 1, locked_until: null }], rowCount: 1 });
  });
}

function currentCode() {
  return authenticator.generate(SECRET);
}

/** Did any query increment the SEC-1.3 failure counter? */
function failureRecorded() {
  return db.query.mock.calls.some(
    ([sql]) => typeof sql === "string" && sql.includes("failed_login_attempts = CASE")
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  console.warn.mockRestore();
  console.error.mockRestore();
});

describe("admins without MFA are unaffected", () => {
  it("logs in with just email and password", async () => {
    mockLookup(adminRow());
    const res = makeRes();

    await login({ body: { email: "admin@example.com", password: PASSWORD } }, res);

    expect(res.json).toHaveBeenCalledTimes(1);
    const payload = res.json.mock.calls[0][0];
    expect(payload.accessToken).toBeDefined();
    expect(jwt.verify(payload.accessToken, process.env.ADMIN_JWT_SECRET).role).toBe("admin");
  });

  it("ignores a totpCode sent to an unenrolled account", async () => {
    mockLookup(adminRow());
    const res = makeRes();

    await login(
      { body: { email: "admin@example.com", password: PASSWORD, totpCode: "000000" } },
      res
    );

    expect(res.json.mock.calls[0][0].accessToken).toBeDefined();
  });
});

describe("enrollment state is not disclosed to an unauthenticated caller", () => {
  it("answers the generic 401 for a wrong password on an MFA account", async () => {
    mockLookup(mfaAdminRow());
    const res = makeRes();

    await login({ body: { email: "admin@example.com", password: "wrong" } }, res);

    expect(res.status).toHaveBeenCalledWith(401);
    const body = res.json.mock.calls[0][0];
    // Identical to the non-MFA wrong-password response: no code field, same
    // message. Otherwise a password sprayer could enumerate which admins have
    // a second factor and target the one that doesn't.
    expect(body).toEqual({ message: "Invalid email or password." });
    expect(body.code).toBeUndefined();
  });

  it("gives the same generic 401 for a wrong password whether or not MFA is on", async () => {
    mockLookup(adminRow());
    const withoutMfa = makeRes();
    await login({ body: { email: "admin@example.com", password: "wrong" } }, withoutMfa);

    mockLookup(mfaAdminRow());
    const withMfa = makeRes();
    await login({ body: { email: "admin@example.com", password: "wrong" } }, withMfa);

    expect(withMfa.json.mock.calls[0][0]).toEqual(withoutMfa.json.mock.calls[0][0]);
  });
});

describe("second factor is required once enrolled", () => {
  it("refuses a correct password alone with MFA_REQUIRED and issues no token", async () => {
    mockLookup(mfaAdminRow());
    const res = makeRes();

    await login({ body: { email: "admin@example.com", password: PASSWORD } }, res);

    expect(res.status).toHaveBeenCalledWith(401);
    const body = res.json.mock.calls[0][0];
    expect(body.code).toBe("MFA_REQUIRED");
    // No token of any kind - not a partial one, not a challenge one.
    expect(JSON.stringify(body)).not.toContain("Token");
    expect(body.accessToken).toBeUndefined();
  });

  it("does not count a missing code against the lockout budget", async () => {
    // The dashboard triggers this on every first submission; charging it to the
    // lockout counter would lock an admin out for logging in normally.
    mockLookup(mfaAdminRow());
    await login({ body: { email: "admin@example.com", password: PASSWORD } }, makeRes());

    expect(failureRecorded()).toBe(false);
  });

  it("accepts a correct password plus a correct code", async () => {
    mockLookup(mfaAdminRow());
    const res = makeRes();

    await login(
      { body: { email: "admin@example.com", password: PASSWORD, totpCode: currentCode() } },
      res
    );

    expect(res.json.mock.calls[0][0].accessToken).toBeDefined();
  });

  it("refuses a wrong code and counts it toward the SEC-1.3 lockout", async () => {
    mockLookup(mfaAdminRow());
    const res = makeRes();

    await login(
      { body: { email: "admin@example.com", password: PASSWORD, totpCode: "000000" } },
      res
    );

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json.mock.calls[0][0].code).toBe("MFA_INVALID");
    // Without this the only brute-force control on 10^6 codes is a per-IP,
    // in-memory limiter that resets on every restart.
    expect(failureRecorded()).toBe(true);
  });

  it("refuses a replayed code", async () => {
    const step = Math.floor(Date.now() / 1000 / 30);
    mockLookup(mfaAdminRow({ mfa_last_timestep: step }));
    const res = makeRes();

    await login(
      { body: { email: "admin@example.com", password: PASSWORD, totpCode: currentCode() } },
      res
    );

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json.mock.calls[0][0].code).toBe("MFA_INVALID");
  });

  it("refuses when the stored secret cannot be decrypted, rather than bypassing", async () => {
    mockLookup(mfaAdminRow({ mfa_secret: "v1.CORRUPT.CORRUPT.CORRUPT" }));
    const res = makeRes();

    await login(
      { body: { email: "admin@example.com", password: PASSWORD, totpCode: currentCode() } },
      res
    );

    // A wrong MFA_ENCRYPTION_KEY must fail closed. Reading as "no second
    // factor configured" would make a mis-set env var a fleet-wide bypass.
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json.mock.calls[0][0].accessToken).toBeUndefined();
  });

  it("still refuses a locked account before ever looking at the code", async () => {
    mockLookup(mfaAdminRow({ is_locked: true }));
    const res = makeRes();

    await login(
      { body: { email: "admin@example.com", password: PASSWORD, totpCode: currentCode() } },
      res
    );

    expect(res.json.mock.calls[0][0]).toEqual({ message: "Invalid email or password." });
  });
});

describe("recovery codes", () => {
  it("accepts a valid recovery code in place of a TOTP code", async () => {
    const code = "ABCDEFGH23456722";
    const hash = await bcrypt.hash(code, 4);

    db.query.mockReset();
    db.query.mockImplementation((sql) => {
      if (sql.includes("FROM admins")) return Promise.resolve({ rows: [mfaAdminRow()], rowCount: 1 });
      if (sql.includes("FROM admin_mfa_recovery_codes")) {
        return Promise.resolve({ rows: [{ id: "rc-1", code_hash: hash }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [{}], rowCount: 1 });
    });

    const res = makeRes();
    await login(
      { body: { email: "admin@example.com", password: PASSWORD, recoveryCode: code } },
      res
    );

    expect(res.json.mock.calls[0][0].accessToken).toBeDefined();
  });

  it("refuses an invalid recovery code and counts it toward the lockout", async () => {
    db.query.mockReset();
    db.query.mockImplementation((sql) => {
      if (sql.includes("FROM admins")) return Promise.resolve({ rows: [mfaAdminRow()], rowCount: 1 });
      if (sql.includes("FROM admin_mfa_recovery_codes")) return Promise.resolve({ rows: [], rowCount: 0 });
      return Promise.resolve({ rows: [{ failed_login_attempts: 1, locked_until: null }], rowCount: 1 });
    });

    const res = makeRes();
    await login(
      { body: { email: "admin@example.com", password: PASSWORD, recoveryCode: "AAAAAAAA33333333" } },
      res
    );

    expect(res.status).toHaveBeenCalledWith(401);
    expect(failureRecorded()).toBe(true);
  });
});

describe("no secret material escapes in a response", () => {
  it("never returns the TOTP secret or the encrypted blob", async () => {
    mockLookup(mfaAdminRow());
    const res = makeRes();

    await login(
      { body: { email: "admin@example.com", password: PASSWORD, totpCode: currentCode() } },
      res
    );

    const serialized = JSON.stringify(res.json.mock.calls[0][0]);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("mfa_secret");
    expect(serialized).not.toContain("v1.");
  });
});
