/**
 * Phase 8 end-to-end HTTP suite.
 *
 * The unit suites assert the detectors and the policy; this asserts they are
 * actually MOUNTED and reachable with the right authorization. A detector that
 * is never wired to a route, or a review endpoint that any viewer can use to
 * suspend accounts, is a failure mode invisible to a unit test.
 */

require("../critical/setupEnv");

jest.mock("../../src/config/db", () => ({
  query: jest.fn(),
  analyticsQuery: jest.fn(),
  pool: { connect: jest.fn() },
  buildSslConfig: () => false,
}));
jest.mock("../../src/config/supabase", () => ({ storage: { from: () => ({}) } }));
jest.mock("../../src/services/sessionService", () => {
  const actual = require("../mocks/activeSession");
  return { ...actual, listLiveSessions: jest.fn().mockResolvedValue([]) };
});

const jwt = require("jsonwebtoken");
const request = require("supertest");
const app = require("../../src/app");
const db = require("../../src/config/db");

const USER = "550e8400-e29b-41d4-a716-446655440000";
const FINDING = "11111111-2222-4333-8444-555555555555";

const adminToken = (adminRole = "superadmin") =>
  jwt.sign(
    { sub: "admin-1", email: "a@x.com", role: "admin", adminRole },
    process.env.ADMIN_JWT_SECRET,
    { expiresIn: "2h" }
  );

const userToken = () =>
  jwt.sign(
    { sub: USER, email: "u@x.com", role: "authenticated", aud: "authenticated", type: "access" },
    process.env.SUPABASE_JWT_SECRET,
    { expiresIn: "1h" }
  );

beforeEach(() => jest.clearAllMocks());

// ---------------------------------------------------------------------------
// SEC-18.1 — the review workflow is mounted and authorized
// ---------------------------------------------------------------------------

describe("SEC-18.1 — abuse review endpoints", () => {
  it("lists findings for an admin and states whether enforcement is armed", async () => {
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });

    const res = await request(app)
      .get("/api/admin/abuse/findings")
      .set("Authorization", `Bearer ${adminToken("viewer")}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.findings)).toBe(true);
    // An operator must be able to tell, from the queue itself, whether the
    // system is currently allowed to act on its own.
    expect(res.body.autoSuspendEnabled).toBe(false);
  });

  it("returns the risk ranking with an explicit caveat about what the score is", async () => {
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });

    const res = await request(app)
      .get("/api/admin/abuse/risk")
      .set("Authorization", `Bearer ${adminToken("viewer")}`);

    expect(res.status).toBe(200);
    // Stated in the payload, not only in a doc: a field labelled "risk" on a
    // dashboard is otherwise read as a probability and then as grounds to act.
    expect(res.body.note).toMatch(/not a probability/i);
  });

  it("rejects an unauthenticated caller", async () => {
    expect((await request(app).get("/api/admin/abuse/findings")).status).toBe(401);
    expect((await request(app).post("/api/admin/abuse/sweep")).status).toBe(401);
  });

  // SEC-15.4's tiering must hold for the new routes too: the writes are the
  // ones that can suspend accounts or shape future thresholds.
  it("refuses a viewer on the write endpoints", async () => {
    const sweep = await request(app)
      .post("/api/admin/abuse/sweep")
      .set("Authorization", `Bearer ${adminToken("viewer")}`);
    expect(sweep.status).toBe(403);

    const review = await request(app)
      .post(`/api/admin/abuse/findings/${FINDING}/review`)
      .set("Authorization", `Bearer ${adminToken("viewer")}`)
      .send({ outcome: "confirmed" });
    expect(review.status).toBe(403);
  });

  it("refuses a regular user token on an admin route", async () => {
    const res = await request(app)
      .get("/api/admin/abuse/findings")
      .set("Authorization", `Bearer ${userToken()}`);
    expect(res.status).toBe(401);
  });

  it("validates the review outcome against an allow-list", async () => {
    const res = await request(app)
      .post(`/api/admin/abuse/findings/${FINDING}/review`)
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({ outcome: "whatever-i-like" });
    expect(res.status).toBe(400);
  });

  it("rejects a malformed finding id with 400 (SEC-9.1 discipline)", async () => {
    const res = await request(app)
      .post("/api/admin/abuse/findings/not-a-uuid/review")
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({ outcome: "confirmed" });
    expect(res.status).toBe(400);
  });

  it("404s a review of a finding that does not exist", async () => {
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });
    const res = await request(app)
      .post(`/api/admin/abuse/findings/${FINDING}/review`)
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({ outcome: "false_positive" });
    expect(res.status).toBe(404);
  });
});

describe("SEC-18.5 — the session list never exposes an address or a credential", () => {
  it("returns hashed origins only", async () => {
    const sessionService = require("../../src/services/sessionService");
    sessionService.listLiveSessions.mockResolvedValue([
      { familyId: "f1", issuedAt: new Date().toISOString(), usedAt: null,
        originHash: "abcdef0123456789abcdef0123456789", deviceLabel: "mobile-app" },
    ]);

    const res = await request(app)
      .get(`/api/admin/abuse/users/${USER}/sessions`)
      .set("Authorization", `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/token_hash|tokenHash/);
    // No dotted-quad anywhere: there is no path from this endpoint back to an
    // IP, by construction rather than by redaction.
    expect(body).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
  });
});

// ---------------------------------------------------------------------------
// SEC-18.4 — signup controls are mounted
// ---------------------------------------------------------------------------

describe("SEC-18.4 — bot controls on the signup surface", () => {
  it("rejects a disposable address at registration before any DB work", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ email: "farm@mailinator.com", password: "Str0ng!Passw0rd", fullName: "A B" });

    expect(res.status).toBe(400);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("rejects a disposable address on resend-verification", async () => {
    const res = await request(app)
      .post("/api/auth/resend-verification")
      .send({ email: "farm@guerrillamail.com" });
    expect(res.status).toBe(400);
  });

  it("applies the domain check to the Google path too", async () => {
    // The Google path skips the CAPTCHA (the token already proves a real
    // Google account) but NOT the domain check - it produces an instantly
    // verified account with no email round-trip, so it is the cheaper of the
    // two to farm.
    const res = await request(app)
      .post("/api/auth/google")
      .send({ idToken: "x", email: "farm@yopmail.com" });
    expect(res.status).toBe(400);
  });

  it("does NOT block a normal address (the funnel still works)", async () => {
    // Reaches the controller and fails later for an unrelated reason; the
    // assertion is that signupControls did not reject it.
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });
    const res = await request(app)
      .post("/api/auth/register")
      .send({ email: "real.person@gmail.com", password: "Str0ng!Passw0rd", fullName: "A B" });

    expect(res.status).not.toBe(400);
  });
});

// ---------------------------------------------------------------------------
// The opportunistic sweep must not perturb ordinary requests
// ---------------------------------------------------------------------------

describe("SEC-18.1 — the sweep trigger is inert under test and never breaks a request", () => {
  it("serves an ordinary request without touching abuse tables", async () => {
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });

    const res = await request(app).get("/healthz");
    expect(res.status).toBeLessThan(500);

    const touched = db.query.mock.calls.some((c) =>
      /abuse_findings|user_risk_scores/.test(String(c[0]))
    );
    expect(touched).toBe(false);
  });
});
