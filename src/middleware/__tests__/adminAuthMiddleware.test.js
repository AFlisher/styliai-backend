const jwt = require("jsonwebtoken");

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

  it("calls next() with no req.admin when no Authorization header is present", () => {
    const { req, res, next } = makeReqRes(undefined);

    optionalAdminAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.admin).toBeUndefined();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("calls next() with no req.admin when the header isn't 'Bearer <token>'", () => {
    const { req, res, next } = makeReqRes("NotBearer abc123");

    optionalAdminAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.admin).toBeUndefined();
  });

  it("calls next() with no req.admin when the token is invalid/garbage (e.g. a mobile user's Supabase JWT)", () => {
    const { req, res, next } = makeReqRes("Bearer garbage.invalid.token");

    optionalAdminAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.admin).toBeUndefined();
  });

  it("calls next() with no req.admin when the token is valid but role isn't 'admin'", () => {
    const token = jwt.sign({ sub: "user-1", role: "user" }, TEST_SECRET);
    const { req, res, next } = makeReqRes(`Bearer ${token}`);

    optionalAdminAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.admin).toBeUndefined();
  });

  it("sets req.admin and calls next() when a valid admin token is presented", () => {
    const token = jwt.sign({ sub: "admin-1", email: "admin@example.com", role: "admin" }, TEST_SECRET);
    const { req, res, next } = makeReqRes(`Bearer ${token}`);

    optionalAdminAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.admin).toEqual({ id: "admin-1", email: "admin@example.com", role: "admin" });
  });

  it("never rejects the request (no res.status/res.json call in any case)", () => {
    for (const header of [undefined, "Bearer bad", "Bearer garbage.invalid.token"]) {
      const { req, res, next } = makeReqRes(header);
      optionalAdminAuth(req, res, next);
      expect(res.status).not.toHaveBeenCalled();
      expect(res.json).not.toHaveBeenCalled();
    }
  });
});
