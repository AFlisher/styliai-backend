// Covers SEC-1.1 (token-type confusion): authMiddleware must only accept
// access tokens - a refresh token signed with the same secret must never
// pass, because that would bypass the DB-backed revocation check that only
// the /refresh endpoint performs (defeating logout and password reset).
const jwt = require("jsonwebtoken");

const TEST_SECRET = "test-only-secret-never-used-in-production";

function makeReqRes(authHeader) {
  const req = { headers: authHeader ? { authorization: authHeader } : {} };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const next = jest.fn();
  return { req, res, next };
}

describe("authMiddleware (SEC-1.1)", () => {
  const authMiddleware = require("../authMiddleware");

  const originalSecret = process.env.SUPABASE_JWT_SECRET;
  beforeAll(() => {
    process.env.SUPABASE_JWT_SECRET = TEST_SECRET;
  });
  afterAll(() => {
    process.env.SUPABASE_JWT_SECRET = originalSecret;
  });

  beforeEach(() => {
    jest.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    console.error.mockRestore();
  });

  it("accepts a current access token (aud + type claims) and sets req.user", () => {
    const token = jwt.sign(
      { sub: "user-1", email: "u@example.com", role: "authenticated", aud: "authenticated", type: "access" },
      TEST_SECRET
    );
    const { req, res, next } = makeReqRes(`Bearer ${token}`);

    authMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user).toEqual({ id: "user-1", email: "u@example.com", role: "authenticated" });
    expect(res.status).not.toHaveBeenCalled();
  });

  it("accepts a legacy access token (aud claim, no type claim) issued before SEC-1.1", () => {
    const token = jwt.sign(
      { sub: "user-1", email: "u@example.com", role: "authenticated", aud: "authenticated" },
      TEST_SECRET
    );
    const { req, res, next } = makeReqRes(`Bearer ${token}`);

    authMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user.id).toBe("user-1");
  });

  it("rejects a current refresh token (type:'refresh', no aud) presented as an access token", () => {
    const token = jwt.sign({ sub: "user-1", type: "refresh" }, TEST_SECRET, { expiresIn: "30d" });
    const { req, res, next } = makeReqRes(`Bearer ${token}`);

    authMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("rejects a legacy refresh token (bare sub, no aud/type) presented as an access token", () => {
    const token = jwt.sign({ sub: "user-1" }, TEST_SECRET, { expiresIn: "30d" });
    const { req, res, next } = makeReqRes(`Bearer ${token}`);

    authMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("rejects a token whose type claim is not 'access' even if aud is correct", () => {
    const token = jwt.sign(
      { sub: "user-1", aud: "authenticated", type: "refresh" },
      TEST_SECRET
    );
    const { req, res, next } = makeReqRes(`Bearer ${token}`);

    authMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("rejects a token signed with a non-pinned algorithm (HS512)", () => {
    const token = jwt.sign(
      { sub: "user-1", aud: "authenticated", type: "access" },
      TEST_SECRET,
      { algorithm: "HS512" }
    );
    const { req, res, next } = makeReqRes(`Bearer ${token}`);

    authMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("rejects an expired access token", () => {
    const token = jwt.sign(
      { sub: "user-1", aud: "authenticated", type: "access" },
      TEST_SECRET,
      { expiresIn: "-1h" }
    );
    const { req, res, next } = makeReqRes(`Bearer ${token}`);

    authMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("rejects a missing/malformed Authorization header", () => {
    for (const header of [undefined, "NotBearer abc123", "Bearer"]) {
      const { req, res, next } = makeReqRes(header);
      authMiddleware(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    }
  });
});
