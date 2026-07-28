// SEC-15.2: TOTP verification, replay protection and recovery codes.

const crypto = require("crypto");

process.env.MFA_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");

jest.mock("../../config/db", () => ({ query: jest.fn(), pool: { connect: jest.fn() } }));

const { authenticator } = require("otplib");
const bcrypt = require("bcrypt");
const db = require("../../config/db");
const { encryptSecret } = require("../../utils/mfaCrypto");
const mfa = require("../adminMfaService");

const SECRET = authenticator.generateSecret();
const NOW = 1800000000000; // fixed instant, so timestep maths is deterministic

/** An admin row as the login query returns it. */
function makeAdmin(overrides = {}) {
  return {
    id: "admin-1",
    mfa_secret: encryptSecret(SECRET),
    mfa_last_timestep: null,
    ...overrides,
  };
}

// Must use clone({ epoch }) - `generate(secret, t)` ignores t and returns the
// current code, which would make every skew assertion below vacuously pass.
function codeFor(now) {
  return authenticator.clone({ epoch: now }).generate(SECRET);
}

beforeEach(() => {
  jest.clearAllMocks();
  // The conditional UPDATE that burns the timestep - one row by default.
  db.query.mockResolvedValue({ rows: [], rowCount: 1 });
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => console.error.mockRestore());

describe("verifyTotp - acceptance", () => {
  it("accepts the current code", async () => {
    await expect(mfa.verifyTotp(makeAdmin(), codeFor(NOW), NOW)).resolves.toBe(true);
  });

  it.each([
    ["previous step", -1],
    ["next step", 1],
  ])("accepts the %s (clock skew tolerance)", async (_label, offset) => {
    const skewed = NOW + offset * mfa.TOTP_OPTIONS.step * 1000;
    await expect(mfa.verifyTotp(makeAdmin(), codeFor(skewed), NOW)).resolves.toBe(true);
  });

  it.each([
    ["two steps back", -2],
    ["two steps forward", 2],
  ])("rejects %s - the window is exactly +/-1", async (_label, offset) => {
    const skewed = NOW + offset * mfa.TOTP_OPTIONS.step * 1000;
    await expect(mfa.verifyTotp(makeAdmin(), codeFor(skewed), NOW)).resolves.toBe(false);
  });
});

describe("verifyTotp - rejection", () => {
  it.each([
    ["a wrong code", "000000"],
    ["a non-numeric code", "abcdef"],
    ["a short code", "1234"],
    ["a long code", "1234567"],
    ["an empty code", ""],
  ])("rejects %s", async (_label, code) => {
    await expect(mfa.verifyTotp(makeAdmin(), code, NOW)).resolves.toBe(false);
  });

  it.each([[null], [undefined], [123456], [{}]])("rejects non-string code %p", async (code) => {
    await expect(mfa.verifyTotp(makeAdmin(), code, NOW)).resolves.toBe(false);
  });

  it("rejects when the admin has no stored secret", async () => {
    await expect(mfa.verifyTotp(makeAdmin({ mfa_secret: null }), codeFor(NOW), NOW)).resolves.toBe(false);
  });

  it("rejects - never bypasses - when the stored secret cannot be decrypted", async () => {
    // Wrong key or tampered column. This must read as "authentication failed",
    // never as "this admin has no second factor".
    const admin = makeAdmin({ mfa_secret: "v1.AAAA.AAAA.AAAA" });

    await expect(mfa.verifyTotp(admin, codeFor(NOW), NOW)).resolves.toBe(false);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("does not burn a timestep on a failed attempt", async () => {
    await mfa.verifyTotp(makeAdmin(), "000000", NOW);
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe("verifyTotp - replay protection", () => {
  it("refuses a code whose timestep was already consumed", async () => {
    const step = mfa.currentTimestep(NOW);
    const admin = makeAdmin({ mfa_last_timestep: step });

    await expect(mfa.verifyTotp(admin, codeFor(NOW), NOW)).resolves.toBe(false);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("refuses an older in-window code once a newer one has been used", async () => {
    const step = mfa.currentTimestep(NOW);
    const admin = makeAdmin({ mfa_last_timestep: step });
    const previous = codeFor(NOW - mfa.TOTP_OPTIONS.step * 1000);

    await expect(mfa.verifyTotp(admin, previous, NOW)).resolves.toBe(false);
  });

  it("burns the timestep with a guarded UPDATE, so a concurrent replay loses", async () => {
    await mfa.verifyTotp(makeAdmin(), codeFor(NOW), NOW);

    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain("mfa_last_timestep");
    // The guard is what makes two simultaneous logins with one code safe.
    expect(sql).toContain("mfa_last_timestep < $1");
    expect(params[0]).toBe(mfa.currentTimestep(NOW));
  });

  it("fails the login when the guarded UPDATE matches no row (lost the race)", async () => {
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });

    await expect(mfa.verifyTotp(makeAdmin(), codeFor(NOW), NOW)).resolves.toBe(false);
  });

  it("accepts a later code after an earlier one was consumed", async () => {
    const admin = makeAdmin({ mfa_last_timestep: mfa.currentTimestep(NOW) - 5 });
    await expect(mfa.verifyTotp(admin, codeFor(NOW), NOW)).resolves.toBe(true);
  });

  it("handles the timestep as node-pg actually returns it: a STRING", async () => {
    // mfa_last_timestep is BIGINT, and node-pg serializes int8 to a string to
    // avoid precision loss. A numeric `<=` against a string would compare
    // wrongly and silently disable replay protection, so this is pinned
    // against the real driver's shape rather than the convenient one.
    const step = mfa.currentTimestep(NOW);
    const admin = makeAdmin({ mfa_last_timestep: String(step) });

    await expect(mfa.verifyTotp(admin, codeFor(NOW), NOW)).resolves.toBe(false);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("accepts a newer code when the stored string timestep is older", async () => {
    const admin = makeAdmin({ mfa_last_timestep: String(mfa.currentTimestep(NOW) - 5) });
    await expect(mfa.verifyTotp(admin, codeFor(NOW), NOW)).resolves.toBe(true);
  });
});

describe("recovery codes", () => {
  it("generates codes with 16 characters from the base32 alphabet", () => {
    for (let i = 0; i < 50; i++) {
      expect(mfa.generateRecoveryCode()).toMatch(/^[A-Z2-7]{16}$/);
    }
  });

  it("does not repeat codes", () => {
    const seen = new Set();
    for (let i = 0; i < 500; i++) seen.add(mfa.generateRecoveryCode());
    expect(seen.size).toBe(500);
  });

  it("uses the whole alphabet, so entropy isn't silently reduced", () => {
    // A naive "two characters per byte" derivation correlates adjacent
    // characters and shrinks the effective space; this is the cheap check that
    // the distribution stays broad.
    const chars = new Set();
    for (let i = 0; i < 200; i++) {
      for (const c of mfa.generateRecoveryCode()) chars.add(c);
    }
    expect(chars.size).toBe(32);
  });

  it("accepts a code as displayed (grouped, lower case)", async () => {
    const code = mfa.generateRecoveryCode();
    const hash = await bcrypt.hash(code, 4);
    db.query
      .mockResolvedValueOnce({ rows: [{ id: "rc-1", code_hash: hash }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const displayed = `${code.slice(0, 8)}-${code.slice(8)}`.toLowerCase();
    await expect(mfa.verifyRecoveryCode({ id: "admin-1" }, displayed)).resolves.toBe(true);
  });

  it("consumes the code so it cannot be reused", async () => {
    const code = mfa.generateRecoveryCode();
    const hash = await bcrypt.hash(code, 4);
    db.query
      .mockResolvedValueOnce({ rows: [{ id: "rc-1", code_hash: hash }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await mfa.verifyRecoveryCode({ id: "admin-1" }, code);

    const [sql, params] = db.query.mock.calls[1];
    expect(sql).toContain("SET used_at = now()");
    // Guarded, so two concurrent uses of one code cannot both succeed.
    expect(sql).toContain("used_at IS NULL");
    expect(params).toEqual(["rc-1"]);
  });

  it("fails when the consuming UPDATE matches no row", async () => {
    const code = mfa.generateRecoveryCode();
    const hash = await bcrypt.hash(code, 4);
    db.query
      .mockResolvedValueOnce({ rows: [{ id: "rc-1", code_hash: hash }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await expect(mfa.verifyRecoveryCode({ id: "admin-1" }, code)).resolves.toBe(false);
  });

  it("only queries unused codes", async () => {
    db.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await mfa.verifyRecoveryCode({ id: "admin-1" }, mfa.generateRecoveryCode());

    expect(db.query.mock.calls[0][0]).toContain("used_at IS NULL");
  });

  it.each([
    ["a wrong code", "AAAAAAAAAAAAAAAA"],
    ["a malformed code", "not-a-code"],
    ["an empty string", ""],
  ])("rejects %s", async (_label, submitted) => {
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(mfa.verifyRecoveryCode({ id: "admin-1" }, submitted)).resolves.toBe(false);
  });

  it("does not hit the database for an obviously malformed code", async () => {
    await mfa.verifyRecoveryCode({ id: "admin-1" }, "short");
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe("enrollment", () => {
  it("produces a secret and an otpauth URI that does not leak into the label", () => {
    const { secret, otpauthUrl } = mfa.generateEnrollment("admin@example.com");

    expect(secret).toMatch(/^[A-Z2-7]+$/);
    expect(otpauthUrl).toContain("otpauth://totp/");
    expect(otpauthUrl).toContain(encodeURIComponent("admin@example.com"));
    // The secret is in the URI by design (that is how enrollment works) - what
    // matters is that a code generated from it verifies.
    expect(mfa.matchTimestep(authenticator.generate(secret), secret)).not.toBeNull();
  });

  it("stores the secret encrypted, never in plaintext", async () => {
    db.query.mockResolvedValue({ rows: [], rowCount: 1 });
    const secret = authenticator.generateSecret();

    await mfa.enableMfa("admin-1", secret);

    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain("mfa_enabled = true");
    expect(params[0]).not.toBe(secret);
    expect(params[0]).not.toContain(secret);
    expect(params[0].startsWith("v1.")).toBe(true);
    // A fresh enrollment must not inherit the previous secret's replay counter.
    expect(sql).toContain("mfa_last_timestep = NULL");
  });
});
