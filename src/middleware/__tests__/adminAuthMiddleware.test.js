const jwt = require("jsonwebtoken");
// Phase 6 (SEC-15.3): the admin middleware now consults server-side session
// state on every request, so the token alone is no longer sufficient. Mocked
// at the service seam; the enforcement it enables is asserted at the bottom.
jest.mock("../../services/sessionService", () => ({
  ...jest.requireActual("../../services/sessionService"),
  getAdminSessionState: jest.fn().mockResolvedValue({ token_version: 0 }),
}));
const sessionService = require("../../services/sessionService");

const TEST_SECRET = "test-only-secret-never-used-in-production";

function makeReqRes(authHeader) {
  const req = { headers: authHeader ? { authorization: authHeader } : {} };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const next = jest.fn();
  return { req, res, next };
}

describe("adminAuthMiddleware.optionalAdminAuth", () => {
  const { optionalAdminAuth } = require("../adminAuthMiddleware");

  const originalSecret = process.env.ADMIN_JWT_SECRET;
  beforeAll(() => {
    process.env.ADMIN_JWT_SECRET = TEST_SECRET;
  });
  afterAll(() => {
    process.env.ADMIN_JWT_SECRET = originalSecret;
  });

  beforeEach(() => {
    jest.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    console.error.mockRestore();
  });

  it("calls next() with no req.admin when no Authorization header is present", async () => {
    const { req, res, next } = makeReqRes(undefined);

    await optionalAdminAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.admin).toBeUndefined();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("calls next() with no req.admin when the header isn't 'Bearer <token>'", async () => {
    const { req, res, next } = makeReqRes("NotBearer abc123");

    await optionalAdminAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.admin).toBeUndefined();
  });

  it("calls next() with no req.admin when the token is invalid/garbage (e.g. a mobile user's Supabase JWT)", async () => {
    const { req, res, next } = makeReqRes("Bearer garbage.invalid.token");

    await optionalAdminAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.admin).toBeUndefined();
  });

  it("calls next() with no req.admin when the token is valid but role isn't 'admin'", async () => {
    const token = jwt.sign({ sub: "user-1", role: "user" }, TEST_SECRET);
    const { req, res, next } = makeReqRes(`Bearer ${token}`);

    await optionalAdminAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.admin).toBeUndefined();
  });

  it("sets req.admin and calls next() when a valid admin token is presented", async () => {
    const token = jwt.sign({ sub: "admin-1", email: "admin@example.com", role: "admin" }, TEST_SECRET);
    const { req, res, next } = makeReqRes(`Bearer ${token}`);

    await optionalAdminAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.admin).toEqual({ id: "admin-1", email: "admin@example.com", role: "admin" });
  });

  it("carries the SEC-15.4 adminRole claim through to req.admin", async () => {
    // The link between authentication and authorization: requireAdminRole
    // reads req.admin.adminRole, so if this claim were dropped here every
    // guarded route would fail closed. Asserted explicitly because toEqual
    // treats an absent property and an undefined one as equal, so the test
    // above would pass either way.
    const token = jwt.sign(
      { sub: "admin-1", email: "admin@example.com", role: "admin", adminRole: "editor" },
      TEST_SECRET
    );
    const { req, res, next } = makeReqRes(`Bearer ${token}`);

    await optionalAdminAuth(req, res, next);

    expect(req.admin.adminRole).toBe("editor");
  });

  it("never rejects the request (no res.status/res.json call in any case)", async () => {
    for (const header of [undefined, "Bearer bad", "Bearer garbage.invalid.token"]) {
      const { req, res, next } = makeReqRes(header);
      await optionalAdminAuth(req, res, next);
      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
    }
  });
});

// SEC-1.7: both admin verification paths must accept HS256 and nothing else.
//
// Without an explicit `algorithms` pin, jsonwebtoken widens the accepted set to
// the whole HMAC family (HS256/HS384/HS512) whenever the key resolves to a
// secret. Every one of those still requires the same shared secret, so this was
// never a forgery route - the pin exists so the accepted set is stated by this
// codebase rather than inherited from a `^9.0.3` dependency's defaults, and so
// that any future move to an asymmetric key cannot silently admit the
// public-key-as-HMAC-secret confusion attack.
describe("adminAuthMiddleware - algorithm pinning (SEC-1.7)", () => {
  const crypto = require("crypto");
  const adminAuthMiddleware = require("../adminAuthMiddleware");
  const { optionalAdminAuth } = require("../adminAuthMiddleware");

  const ADMIN_CLAIMS = {
    sub: "admin-1",
    email: "admin@example.com",
    role: "admin"
  };

  const originalSecret = process.env.ADMIN_JWT_SECRET;
  beforeAll(() => {
    process.env.ADMIN_JWT_SECRET = TEST_SECRET;
  });
  afterAll(() => {
    process.env.ADMIN_JWT_SECRET = originalSecret;
  });

  beforeEach(() => {
    jest.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    console.error.mockRestore();
  });

  function expectRejected(token) {
    const strict = makeReqRes(`Bearer ${token}`);
    adminAuthMiddleware(strict.req, strict.res, strict.next);
    expect(strict.next).not.toHaveBeenCalled();
    expect(strict.req.admin).toBeUndefined();
    expect(strict.res.status).toHaveBeenCalledWith(401);

    // The permissive variant must not attach req.admin either.
    const optional = makeReqRes(`Bearer ${token}`);
    optionalAdminAuth(optional.req, optional.res, optional.next);
    expect(optional.next).toHaveBeenCalledTimes(1);
    expect(optional.req.admin).toBeUndefined();
  }

  it("accepts a genuine HS256 admin token (baseline - real tokens keep working)", async () => {
    const token = jwt.sign(ADMIN_CLAIMS, TEST_SECRET, { algorithm: "HS256" });

    const { req, res, next } = makeReqRes(`Bearer ${token}`);
    await adminAuthMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.admin).toEqual({
      id: "admin-1",
      email: "admin@example.com",
      role: "admin"
    });
    expect(res.status).not.toHaveBeenCalled();
  });

  it("rejects HS384 signed with the same secret", async () => {
    expectRejected(jwt.sign(ADMIN_CLAIMS, TEST_SECRET, { algorithm: "HS384" }));
  });

  it("rejects HS512 signed with the same secret", async () => {
    expectRejected(jwt.sign(ADMIN_CLAIMS, TEST_SECRET, { algorithm: "HS512" }));
  });

  it("rejects an unsigned alg:none token", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify(ADMIN_CLAIMS)).toString("base64url");
    expectRejected(`${header}.${payload}.`);
  });

  it("rejects an RS256 token signed with an attacker-generated key", async () => {
    const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    expectRejected(jwt.sign(ADMIN_CLAIMS, privateKey, { algorithm: "RS256" }));
  });

  it("rejects HS256 signed with the wrong secret", async () => {
    expectRejected(jwt.sign(ADMIN_CLAIMS, "a-completely-different-secret-value"));
  });

  it("still answers 403 for a valid HS256 token whose role isn't admin", async () => {
    const token = jwt.sign({ sub: "user-1", role: "user" }, TEST_SECRET, {
      algorithm: "HS256"
    });
    const { req, res, next } = makeReqRes(`Bearer ${token}`);

    await adminAuthMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe("admin session revocation (SEC-15.3, Phase 6)", () => {
  const adminAuthMiddleware = require("../adminAuthMiddleware");
  const { optionalAdminAuth } = require("../adminAuthMiddleware");

  const adminToken = (claims = {}) =>
    jwt.sign(
      { sub: "admin-1", email: "a@x.com", role: "admin", adminRole: "superadmin", ...claims },
      process.env.ADMIN_JWT_SECRET,
      { algorithm: "HS256", expiresIn: "2h" }
    );

  const make = (header) => ({
    req: { headers: header ? { authorization: header } : {} },
    res: { status: jest.fn().mockReturnThis(), json: jest.fn() },
    next: jest.fn(),
  });

  beforeEach(() => {
    sessionService.getAdminSessionState.mockReset();
    sessionService.getAdminSessionState.mockResolvedValue({ token_version: 0 });
  });

  it("refuses an admin token minted before the epoch moved", async () => {
    // The finding: this token lives in the dashboard's localStorage, so an XSS
    // exfiltrates it and it was previously unstoppable for its full 2h life.
    sessionService.getAdminSessionState.mockResolvedValueOnce({ token_version: 5 });
    const { req, res, next } = make(`Bearer ${adminToken({ tv: 4 })}`);

    await adminAuthMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json.mock.calls[0][0].code).toBe("SESSION_REVOKED");
  });

  it("refuses a token for an admin row that no longer exists", async () => {
    sessionService.getAdminSessionState.mockResolvedValueOnce(null);
    const { req, res, next } = make(`Bearer ${adminToken({ tv: 0 })}`);

    await adminAuthMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("FAILS CLOSED with 503 when admin session state cannot be read", async () => {
    sessionService.getAdminSessionState.mockRejectedValueOnce(new Error("db down"));
    const { req, res, next } = make(`Bearer ${adminToken({ tv: 0 })}`);

    await adminAuthMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it("optionalAdminAuth also honours revocation - a revoked token is not an admin", async () => {
    // The two paths must not disagree. If only the strict one checked the
    // epoch, a revoked token would still set req.admin on the shared catalog
    // reads and still receive the admin-shaped response.
    sessionService.getAdminSessionState.mockResolvedValueOnce({ token_version: 9 });
    const { req, res, next } = make(`Bearer ${adminToken({ tv: 1 })}`);

    await optionalAdminAuth(req, res, next);

    expect(next).toHaveBeenCalled();     // non-rejecting by design...
    expect(req.admin).toBeUndefined();   // ...but NOT privileged
  });

  it("optionalAdminAuth FAILS OPEN AS ANONYMOUS when the read throws", async () => {
    // Open here means "treat as an ordinary caller", never "treat as admin".
    // Rejecting instead would take GET /api/styles down for every mobile user
    // whenever the admins table blips, for a request that was never going to
    // be privileged anyway.
    sessionService.getAdminSessionState.mockRejectedValueOnce(new Error("db down"));
    const { req, res, next } = make(`Bearer ${adminToken({ tv: 0 })}`);

    await optionalAdminAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.admin).toBeUndefined();
    expect(res.status).not.toHaveBeenCalled();
  });
});
