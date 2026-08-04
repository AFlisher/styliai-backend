// Covers SEC-1.1 (token-type confusion): authMiddleware must only accept
// access tokens - a refresh token signed with the same secret must never
// pass, because that would bypass the DB-backed revocation check that only
// the /refresh endpoint performs (defeating logout and password reset).
const jwt = require("jsonwebtoken");

// Phase 6: the middleware now also consults server-side session state, so the
// happy paths below need a session to consult. Mocked at the service seam
// rather than at db.query so these tests stay about token validation; the
// enforcement behaviour it enables (revoked epoch, suspended account, unknown
// user, read failure) is asserted in the Phase 6 suite added alongside it, and
// again at the bottom of this file against this same seam.
jest.mock("../../services/sessionService", () => ({
  ...jest.requireActual("../../services/sessionService"),
  getUserSessionState: jest.fn().mockResolvedValue({ token_version: 0, status: "active" }),
}));
const sessionService = require("../../services/sessionService");

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

  it("accepts a current access token (aud + type claims) and sets req.user", async () => {
    const token = jwt.sign(
      { sub: "user-1", email: "u@example.com", role: "authenticated", aud: "authenticated", type: "access" },
      TEST_SECRET
    );
    const { req, res, next } = makeReqRes(`Bearer ${token}`);

    await authMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user).toEqual({ id: "user-1", email: "u@example.com", role: "authenticated" });
    expect(res.status).not.toHaveBeenCalled();
  });

  it("accepts a legacy access token (aud claim, no type claim) issued before SEC-1.1", async () => {
    const token = jwt.sign(
      { sub: "user-1", email: "u@example.com", role: "authenticated", aud: "authenticated" },
      TEST_SECRET
    );
    const { req, res, next } = makeReqRes(`Bearer ${token}`);

    await authMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user.id).toBe("user-1");
  });

  it("rejects a current refresh token (type:'refresh', no aud) presented as an access token", async () => {
    const token = jwt.sign({ sub: "user-1", type: "refresh" }, TEST_SECRET, { expiresIn: "30d" });
    const { req, res, next } = makeReqRes(`Bearer ${token}`);

    await authMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("rejects a legacy refresh token (bare sub, no aud/type) presented as an access token", async () => {
    const token = jwt.sign({ sub: "user-1" }, TEST_SECRET, { expiresIn: "30d" });
    const { req, res, next } = makeReqRes(`Bearer ${token}`);

    await authMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("rejects a token whose type claim is not 'access' even if aud is correct", async () => {
    const token = jwt.sign(
      { sub: "user-1", aud: "authenticated", type: "refresh" },
      TEST_SECRET
    );
    const { req, res, next } = makeReqRes(`Bearer ${token}`);

    await authMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("rejects a token signed with a non-pinned algorithm (HS512)", async () => {
    const token = jwt.sign(
      { sub: "user-1", aud: "authenticated", type: "access" },
      TEST_SECRET,
      { algorithm: "HS512" }
    );
    const { req, res, next } = makeReqRes(`Bearer ${token}`);

    await authMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("rejects an expired access token", async () => {
    const token = jwt.sign(
      { sub: "user-1", aud: "authenticated", type: "access" },
      TEST_SECRET,
      { expiresIn: "-1h" }
    );
    const { req, res, next } = makeReqRes(`Bearer ${token}`);

    await authMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("rejects a missing/malformed Authorization header", async () => {
    for (const header of [undefined, "NotBearer abc123", "Bearer"]) {
      const { req, res, next } = makeReqRes(header);
      await authMiddleware(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    }
  });
  // ---------------------------------------------------------------------
  // Phase 6 enforcement. Everything above proves the token is authentic;
  // these prove that being authentic is no longer sufficient.
  // ---------------------------------------------------------------------

  const accessToken = (claims = {}) =>
    jwt.sign(
      { sub: "user-1", email: "u@example.com", role: "authenticated", aud: "authenticated", type: "access", ...claims },
      TEST_SECRET,
      { expiresIn: "1h" }
    );

  it("rejects a token whose epoch is behind the stored token_version (SESSION_REVOKED)", async () => {
    // The token is perfectly valid: correct signature, unexpired, right claims.
    // It is refused purely because something bumped the epoch after it was
    // minted - a password change, a logout-all, a suspension, or a detected
    // refresh-token reuse.
    sessionService.getUserSessionState.mockResolvedValueOnce({ token_version: 3, status: "active" });
    const { req, res, next } = makeReqRes(`Bearer ${accessToken({ tv: 2 })}`);

    await authMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json.mock.calls[0][0].code).toBe("SESSION_REVOKED");
  });

  it("treats an absent tv claim as epoch 0, so pre-Phase-6 tokens keep working", async () => {
    // Compatibility, deliberately: every access token issued before this
    // deploy lacks the claim. Rejecting them would have signed out every
    // logged-in user the moment Phase 6 shipped.
    sessionService.getUserSessionState.mockResolvedValueOnce({ token_version: 0, status: "active" });
    const { req, res, next } = makeReqRes(`Bearer ${accessToken()}`);

    await authMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("stops honouring a legacy no-tv token once the epoch has moved", async () => {
    // The other half of the compatibility rule: grandfathering is only until
    // something actually revokes. A bump invalidates legacy tokens too.
    sessionService.getUserSessionState.mockResolvedValueOnce({ token_version: 1, status: "active" });
    const { req, res, next } = makeReqRes(`Bearer ${accessToken()}`);

    await authMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("refuses a suspended account mid-session with 403 ACCOUNT_SUSPENDED (SEC-18.2)", async () => {
    // The point of the finding: enforcement happens on the very next request,
    // not at next login. An account worth suspending will never voluntarily
    // re-authenticate.
    for (const status of ["suspended", "banned"]) {
      sessionService.getUserSessionState.mockResolvedValueOnce({ token_version: 0, status });
      const { req, res, next } = makeReqRes(`Bearer ${accessToken({ tv: 0 })}`);

      await authMiddleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json.mock.calls[0][0].code).toBe("ACCOUNT_SUSPENDED");
    }
  });

  it("rejects a valid token for a user that no longer exists", async () => {
    sessionService.getUserSessionState.mockResolvedValueOnce(null);
    const { req, res, next } = makeReqRes(`Bearer ${accessToken({ tv: 0 })}`);

    await authMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("FAILS CLOSED with 503 when session state cannot be read", async () => {
    // The single most important property of this middleware. If the read
    // throws and we called next(), a database blip would silently restore
    // every revoked and suspended session - the whole phase would evaporate
    // exactly when the system is least healthy. 503 is the honest answer.
    sessionService.getUserSessionState.mockRejectedValueOnce(new Error("connection terminated"));
    const { req, res, next } = makeReqRes(`Bearer ${accessToken({ tv: 0 })}`);

    await authMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
  });
});
