// Covers audit findings #5 (short-lived admin tokens, env-configurable) and
// #11 (malformed login bodies answer 400 instead of crashing to a 500), plus
// SEC-1.2/SEC-15.7: unknown admin emails burn a dummy bcrypt compare at the
// same cost as real admin hashes so login timing can't enumerate accounts.

process.env.ADMIN_JWT_SECRET = "test-admin-secret";

jest.mock("../../config/db", () => ({ query: jest.fn(), pool: { connect: jest.fn() } }));
jest.mock("../../services/wallet/walletService", () => ({}));

const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const db = require("../../config/db");
const { login } = require("../adminController");

function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.ADMIN_JWT_EXPIRES_IN;
});

describe("admin login validation (finding #11)", () => {
  it.each([
    ["empty body", {}],
    ["missing password", { email: "admin@example.com" }],
    ["non-string email", { email: 42, password: "x" }],
  ])("answers 400 (not 500) for %s", async (_label, body) => {
    const res = makeRes();
    await login({ body }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe("admin login timing equalization (SEC-1.2/SEC-15.7)", () => {
  it("runs a dummy bcrypt compare at cost 12 for an unknown admin email, then answers the generic 401", async () => {
    const compareSpy = jest.spyOn(bcrypt, "compare");
    try {
      db.query.mockResolvedValueOnce({ rows: [] });
      const res = makeRes();

      await login({ body: { email: "nobody@example.com", password: "whatever" } }, res);

      expect(compareSpy).toHaveBeenCalledTimes(1);
      // The dummy must carry the same cost factor (12) as real admin hashes
      // from createAdmin.js, or the timing gap this guards against reopens.
      expect(compareSpy.mock.calls[0][1]).toMatch(/^\$2b\$12\$/);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ message: "Invalid email or password." });
    } finally {
      compareSpy.mockRestore();
    }
  });
});

describe("admin login lockout (SEC-1.3/SEC-15.7)", () => {
  it("rejects a locked admin with the generic 401 + cost-12 dummy compare, never evaluating the real hash", async () => {
    const compareSpy = jest.spyOn(bcrypt, "compare");
    try {
      db.query.mockResolvedValueOnce({
        rows: [{ id: "admin-1", email: "a@x.com", full_name: "Admin", password_hash: "$2b$12$realhash", is_locked: true }],
      });
      const res = makeRes();

      await login({ body: { email: "a@x.com", password: "whatever" } }, res);

      expect(compareSpy).toHaveBeenCalledTimes(1);
      expect(compareSpy.mock.calls[0][1]).toMatch(/^\$2b\$12\$/);
      expect(compareSpy.mock.calls[0][1]).not.toBe("$2b$12$realhash");
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ message: "Invalid email or password." });
      expect(db.query).toHaveBeenCalledTimes(1); // no counter update while locked
    } finally {
      compareSpy.mockRestore();
    }
  });

  it("records a wrong password via the atomic CASE update and stays a generic 401", async () => {
    const passwordHash = await bcrypt.hash("AdminPass1!", 4);
    db.query
      .mockResolvedValueOnce({
        rows: [{ id: "admin-1", email: "a@x.com", full_name: "Admin", password_hash: passwordHash, is_locked: false }],
      })
      .mockResolvedValueOnce({ rows: [{ failed_login_attempts: 1, locked_until: null }] });
    const res = makeRes();

    await login({ body: { email: "a@x.com", password: "wrong" } }, res);

    const updateCall = db.query.mock.calls[1];
    expect(updateCall[0]).toContain("UPDATE admins");
    expect(updateCall[0]).toContain("failed_login_attempts = CASE");
    expect(updateCall[1]).toEqual(["admin-1"]);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("restores the attempt budget on successful login", async () => {
    const passwordHash = await bcrypt.hash("AdminPass1!", 4);
    db.query
      .mockResolvedValueOnce({
        rows: [{ id: "admin-1", email: "a@x.com", full_name: "Admin", password_hash: passwordHash, is_locked: false }],
      })
      .mockResolvedValueOnce({ rows: [] }); // reset UPDATE
    const res = makeRes();

    await login({ body: { email: "a@x.com", password: "AdminPass1!" } }, res);

    const updateCall = db.query.mock.calls[1];
    expect(updateCall[0]).toContain("failed_login_attempts = 0");
    expect(updateCall[0]).toContain("locked_until = NULL");
    expect(res.json.mock.calls[0][0].accessToken).toBeDefined();
  });
});

describe("admin token lifetime (finding #5)", () => {
  async function loginAndDecode() {
    const passwordHash = await bcrypt.hash("AdminPass1!", 4);
    db.query.mockResolvedValueOnce({
      rows: [{ id: "admin-1", email: "admin@example.com", full_name: "Admin", password_hash: passwordHash }],
    });
    const res = makeRes();
    await login({ body: { email: "admin@example.com", password: "AdminPass1!" } }, res);
    const { accessToken } = res.json.mock.calls[0][0];
    return jwt.verify(accessToken, process.env.ADMIN_JWT_SECRET);
  }

  it("defaults to a 2-hour expiry", async () => {
    const decoded = await loginAndDecode();
    expect(decoded.exp - decoded.iat).toBe(2 * 60 * 60);
    expect(decoded.role).toBe("admin");
  });

  it("honors ADMIN_JWT_EXPIRES_IN overrides", async () => {
    process.env.ADMIN_JWT_EXPIRES_IN = "30m";
    const decoded = await loginAndDecode();
    expect(decoded.exp - decoded.iat).toBe(30 * 60);
  });
});
