// Covers audit findings #5 (short-lived admin tokens, env-configurable) and
// #11 (malformed login bodies answer 400 instead of crashing to a 500).

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
