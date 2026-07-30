// The DB is mocked so this suite opens no connection pool: it asserts on what
// the logger writes, and the handlers' own behaviour is covered elsewhere.
// `query` resolving to zero rows drives every endpoint below down its
// "not found / invalid token" branch, which is all these assertions need.
jest.mock("../config/db", () => ({
  query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  pool: { connect: jest.fn() },
}));

const request = require("supertest");

// SEC-16.1: end-to-end proof that no account-recovery token reaches the log
// stream. The unit tests in utils/__tests__/redactUrl.test.js pin the pure
// function's behaviour; this file pins what the *real* app actually writes to
// stdout, which is the thing the finding is about. It exercises app.js's own
// morgan instance rather than a stand-in, so a future format change or a
// dropped token override fails here.
//
// Assertions are made on the captured string (`expect(line).not.toContain(...)`)
// rather than through a negated asymmetric matcher, which can pass vacuously.

const VERIFY_TOKEN = "11111111-2222-3333-4444-555555555555";
const RESET_TOKEN = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

/**
 * Runs `fn` with process.stdout.write intercepted, and returns everything
 * morgan wrote, with ANSI colour codes stripped ("dev" colours the status).
 */
async function captureStdout(fn) {
  const chunks = [];
  const realWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = realWrite;
  }
  // eslint-disable-next-line no-control-regex
  return chunks.join("").replace(/\x1b\[[0-9;]*m/g, "");
}

describe("request log redaction (SEC-16.1)", () => {
  let app;

  let savedLogLevel;

  beforeAll(() => {
    process.env.ADMIN_JWT_SECRET =
      process.env.ADMIN_JWT_SECRET || "test-only-secret-never-used-in-production";
    // The logger is quiet below `error` under NODE_ENV=test so suites are not
    // drowned in output. This one is specifically about what gets written, so
    // it turns request logging on for itself.
    savedLogLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "info";
    app = require("../app");
  });

  afterAll(() => {
    if (savedLogLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = savedLogLevel;
  });

  /** The parsed http_request line, so assertions read named fields. */
  function httpLine(log) {
    const line = log
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .find((o) => o && o.event === "http_request");
    if (!line) throw new Error(`no http_request line in: ${log}`);
    return line;
  }

  beforeEach(() => {
    jest.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    console.error.mockRestore();
  });

  it("does not write the email verification token to the log", async () => {
    const log = await captureStdout(() =>
      request(app).get(`/api/auth/verify?token=${VERIFY_TOKEN}`)
    );

    expect(httpLine(log).path).toContain("/api/auth/verify");
    expect(log).not.toContain(VERIFY_TOKEN);
    expect(log).toContain("token=[REDACTED]");
  });

  it("does not write the password reset token to the log", async () => {
    const log = await captureStdout(() =>
      request(app).get(`/api/auth/reset-password?token=${RESET_TOKEN}`)
    );

    expect(httpLine(log).path).toContain("/api/auth/reset-password");
    expect(log).not.toContain(RESET_TOKEN);
    expect(log).toContain("token=[REDACTED]");
  });

  it("still logs the request path and status, so the log stays useful", async () => {
    const log = await captureStdout(() =>
      request(app).get(`/api/auth/verify?token=${VERIFY_TOKEN}`)
    );

    // Path, method and status code are the primary triage signals - neither
    // the redaction nor the format change may cost us any of them. Asserted as
    // named fields now, plus the correlation id that makes the line joinable.
    const line = httpLine(log);
    expect(line.method).toBe("GET");
    expect(line.path).toBe("/api/auth/verify?token=[REDACTED]");
    expect(line.status).toBe(400);
    expect(typeof line.durationMs).toBe("number");
    expect(line.requestId).toEqual(expect.any(String));
  });

  it("keeps the token key visible so 'token missing' stays distinguishable", async () => {
    // The endpoint answers a different 400 when the token is absent entirely;
    // redaction must not collapse those two cases into one log line.
    const withToken = await captureStdout(() =>
      request(app).get(`/api/auth/verify?token=${VERIFY_TOKEN}`)
    );
    const withoutToken = await captureStdout(() =>
      request(app).get("/api/auth/verify")
    );

    expect(withToken).toContain("token=[REDACTED]");
    expect(withoutToken).not.toContain("token=");
  });

  it("does not alter what handlers see - req.originalUrl stays raw", async () => {
    // verifyAdMobSSVSignature (walletController.js) rebuilds the AdMob signed
    // message from req.originalUrl, so redaction must be confined to the log
    // line. The token override receives a string and returns a string; this
    // pins that it never writes back to the request.
    const db = require("../config/db");
    // Cleared first: this mock is shared across the file, so without it the
    // assertion below could be satisfied by an earlier test's call.
    db.query.mockClear();

    const log = await captureStdout(() =>
      request(app).get(`/api/auth/verify?token=${VERIFY_TOKEN}`)
    );

    expect(log).toContain("token=[REDACTED]");

    // The handler ran against the real token: verifyEmail only reaches the DB
    // when req.query.token is present, and it looks the token up by hash. A
    // request whose token had been redacted in-place would have short-circuited
    // to the "token missing" 400 without ever querying.
    expect(db.query).toHaveBeenCalledTimes(1);
    const [, params] = db.query.mock.calls[0];
    expect(params).toHaveLength(1);
    // Hashed, so not the raw token - but derived from it, and not the empty
    // digest a missing/blank token would produce.
    const crypto = require("crypto");
    expect(params[0]).toBe(
      crypto.createHash("sha256").update(VERIFY_TOKEN).digest("hex")
    );
  });

  it("leaves non-credential query parameters untouched", async () => {
    const log = await captureStdout(() =>
      request(app).get("/api/styles?categoryId=cat-123&all=true")
    );

    expect(log).toContain("categoryId=cat-123");
    expect(log).toContain("all=true");
  });
});
