/**
 * Phase 7 end-to-end HTTP contract suite.
 *
 * Covers the findings whose guarantee is only real once it is observed through
 * the actual Express stack: SEC-9.1 (validation + error mapping), SEC-9.4
 * (payload limit), SEC-11.1 (global backstop), SEC-19.2 (pagination headers)
 * and SEC-9.3 (limit clamping).
 *
 * The unit suites assert the mechanisms; this asserts they are actually
 * MOUNTED. A validator that is never wired into a route is a validator that
 * does nothing, and that failure mode is invisible to a unit test.
 */

require("../critical/setupEnv");

jest.mock("../../src/config/db", () => ({
  query: jest.fn(),
  analyticsQuery: jest.fn(),
  pool: { connect: jest.fn() },
  buildSslConfig: () => false,
}));
jest.mock("../../src/config/supabase", () => ({ storage: { from: () => ({}) } }));
jest.mock("../../src/services/sessionService", () => require("../mocks/activeSession"));

const jwt = require("jsonwebtoken");
const request = require("supertest");
const app = require("../../src/app");
const db = require("../../src/config/db");
const {
  CREATIONS_PAGE_DEFAULT,
  CREATIONS_PAGE_MAX,
  RECOMMENDATION_LIMIT_MAX,
} = require("../../src/utils/pagination");

const USER = "550e8400-e29b-41d4-a716-446655440000";
const STYLE = "11111111-2222-4333-8444-555555555555";

// Same claim shape the other suites use - authMiddleware requires the
// Supabase-issued role/aud/type claims, not just a subject.
const userToken = () =>
  jwt.sign(
    { sub: USER, email: "u@x.com", role: "authenticated", aud: "authenticated", type: "access" },
    process.env.SUPABASE_JWT_SECRET,
    { expiresIn: "1h" }
  );

const adminToken = () =>
  jwt.sign(
    { sub: "admin-1", email: "a@x.com", role: "admin", adminRole: "superadmin" },
    process.env.ADMIN_JWT_SECRET,
    { expiresIn: "2h" }
  );

beforeEach(() => jest.clearAllMocks());

// ---------------------------------------------------------------------------
// SEC-9.1
// ---------------------------------------------------------------------------

describe("SEC-9.1 — malformed ids are refused at the edge, not by Postgres", () => {
  // The finding: this produced a 500. The DB must not even be consulted.
  it("DELETE /api/creations/:id with a bad uuid answers 400 and never queries", async () => {
    const res = await request(app)
      .delete("/api/creations/not-a-uuid")
      .set("Authorization", `Bearer ${userToken()}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(db.query).not.toHaveBeenCalled();
  });

  it("DELETE /api/favorites/:styleId with a bad uuid answers 400", async () => {
    const res = await request(app)
      .delete("/api/favorites/nope")
      .set("Authorization", `Bearer ${userToken()}`);
    expect(res.status).toBe(400);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("POST /api/favorites with a non-uuid styleId answers 400, not 500", async () => {
    const res = await request(app)
      .post("/api/favorites")
      .set("Authorization", `Bearer ${userToken()}`)
      .send({ styleId: "not-a-uuid" });
    expect(res.status).toBe(400);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("GET /api/styles/:id/similar with a bad uuid answers 400", async () => {
    const res = await request(app)
      .get("/api/styles/abc/similar")
      .set("Authorization", `Bearer ${userToken()}`);
    expect(res.status).toBe(400);
  });

  it("GET /api/creations/:id/image with a bad uuid answers 400", async () => {
    const res = await request(app)
      .get("/api/creations/xyz/image")
      .set("Authorization", `Bearer ${userToken()}`);
    expect(res.status).toBe(400);
  });

  // Authorization must still be decided BEFORE input validity, so a malformed
  // id cannot be used to probe which admin routes exist.
  it("answers 401 rather than 400 for an unauthenticated caller with a bad uuid", async () => {
    const res = await request(app).delete("/api/creations/not-a-uuid");
    expect(res.status).toBe(401);
  });
});

describe("SEC-9.1 — malformed JSON is a 400, not a 500", () => {
  it("maps a JSON SyntaxError to 400 with the standard error shape", async () => {
    const res = await request(app)
      .post("/api/favorites")
      .set("Authorization", `Bearer ${userToken()}`)
      .set("Content-Type", "application/json")
      .send('{"styleId": ');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(res.body.requestId).toEqual(expect.any(String));
  });

  it("does not leak the offending body fragment in the message", async () => {
    const res = await request(app)
      .post("/api/favorites")
      .set("Authorization", `Bearer ${userToken()}`)
      .set("Content-Type", "application/json")
      .send('{"secret":"hunter2"');

    expect(JSON.stringify(res.body)).not.toContain("hunter2");
  });
});

describe("SEC-9.1 — admin CRUD type validation", () => {
  // `name?.trim()` threw TypeError on a non-string, which escaped the
  // handler's own validation branch and became a 500.
  it("POST /api/categories with a numeric name answers 400, not 500", async () => {
    const res = await request(app)
      .post("/api/categories")
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({ name: 12345 });

    expect(res.status).toBe(400);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("POST /api/categories with an object name answers 400", async () => {
    const res = await request(app)
      .post("/api/categories")
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({ name: { evil: true } });
    expect(res.status).toBe(400);
  });

  it("rejects a non-boolean isEnabled rather than coercing it", async () => {
    // Coercion would be actively wrong here: z.coerce.boolean() maps the
    // string "false" to true, which would ENABLE a category an operator meant
    // to disable.
    const res = await request(app)
      .post("/api/categories")
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({ name: "Ok", isEnabled: "false" });
    expect(res.status).toBe(400);
  });

  it("rejects unknown fields on the strict admin schemas", async () => {
    const res = await request(app)
      .post("/api/categories")
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({ name: "Ok", isAdmin: true });
    expect(res.status).toBe(400);
  });

  it("still accepts the exact payload the Admin Dashboard sends", async () => {
    db.query.mockResolvedValue({ rows: [{ id: STYLE, name: "Ok" }], rowCount: 1 });
    const res = await request(app)
      .post("/api/categories")
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({ name: "Ok", isEnabled: true });

    expect(res.status).toBe(201);
  });

  it("accepts the dashboard's updateCategory payload (name, isEnabled, sortOrder)", async () => {
    db.query.mockResolvedValue({ rows: [{ id: STYLE }], rowCount: 1 });
    const res = await request(app)
      .put(`/api/categories/${STYLE}`)
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({ name: "Renamed", isEnabled: true, sortOrder: 3 });

    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// SEC-9.4
// ---------------------------------------------------------------------------

describe("SEC-9.4 — the payload limit is explicit and enforced", () => {
  it("answers 413 for a body over the configured limit", async () => {
    const huge = { note: "x".repeat(200 * 1024) }; // 200kb > 100kb
    const res = await request(app)
      .post("/api/favorites")
      .set("Authorization", `Bearer ${userToken()}`)
      .send(huge);

    expect(res.status).toBe(413);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });

  it("still accepts a normal-sized body, so the limit is not over-tight", async () => {
    db.query.mockResolvedValue({ rows: [], rowCount: 1 });
    const res = await request(app)
      .post("/api/favorites")
      .set("Authorization", `Bearer ${userToken()}`)
      .send({ styleId: STYLE });

    expect(res.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// SEC-11.1
// ---------------------------------------------------------------------------

describe("SEC-11.1 — global backstop", () => {
  const { LIMIT_VALUES } = require("../../src/middleware/rateLimiters");

  // The sizing IS the design. A backstop below any route limiter silently
  // becomes that route's real policy, invisibly, because the route's own
  // limiter would never fire to signal it.
  it("is strictly more permissive than every per-route limiter, per minute", () => {
    const global = LIMIT_VALUES.globalLimiter;
    const globalPerMinute = (global.limit / global.windowMs) * 60_000;

    for (const [name, cfg] of Object.entries(LIMIT_VALUES)) {
      if (name === "globalLimiter") continue;
      const perMinute = (cfg.limit / cfg.windowMs) * 60_000;
      expect(globalPerMinute).toBeGreaterThan(perMinute);
    }
  });

  it("specifically exceeds the AdMob SSV callback limiter", () => {
    // SSV callbacks arrive from a few Google IPs on behalf of MANY users, so a
    // backstop that throttled them would drop other people's ad rewards.
    const ssv = LIMIT_VALUES.ssvCallbackLimiter;
    const global = LIMIT_VALUES.globalLimiter;
    expect((global.limit / global.windowMs)).toBeGreaterThan(ssv.limit / ssv.windowMs);
  });

  it("does not throttle the liveness and readiness probes", async () => {
    // Mounted above the limiter deliberately: a probe that can be rate limited
    // reports the service down when it is merely busy.
    for (let i = 0; i < 20; i += 1) {
      const res = await request(app).get("/healthz");
      expect(res.status).not.toBe(429);
    }
  });

  it("covers the 404 handler, which previously had no limiter at all", async () => {
    const res = await request(app).get("/api/definitely-not-a-route");
    // Still a 404 under normal volume - the assertion is that the limiter is
    // in the chain for this path, verified by the header it attaches.
    expect(res.status).toBe(404);
    expect(res.headers["ratelimit-limit"]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// SEC-19.2 / SEC-9.3
// ---------------------------------------------------------------------------

describe("SEC-19.2 — GET /api/creations pagination", () => {
  const row = (i) => ({
    id: `0000000${i}-0000-4000-8000-000000000000`.slice(-36),
    styleId: null,
    styleName: "S",
    imageUrl: "https://p.supabase.co/storage/v1/object/public/creations/a.webp",
    thumbnailUrl: null,
    createdAt: new Date(Date.now() - i * 1000).toISOString(),
  });

  it("keeps the response body a bare ARRAY (no envelope), so old clients work", async () => {
    db.query.mockResolvedValue({ rows: [row(1), row(2)], rowCount: 2 });

    const res = await request(app)
      .get("/api/creations")
      .set("Authorization", `Bearer ${userToken()}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("applies the default page size when no parameters are sent", async () => {
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });
    await request(app).get("/api/creations").set("Authorization", `Bearer ${userToken()}`);

    const params = db.query.mock.calls[0][1];
    // limit + 1 is fetched to answer "is there more?" without a COUNT.
    expect(params[params.length - 1]).toBe(CREATIONS_PAGE_DEFAULT + 1);
  });

  it("clamps an absurd client limit to the maximum", async () => {
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });
    await request(app)
      .get("/api/creations?limit=99999999")
      .set("Authorization", `Bearer ${userToken()}`);

    const params = db.query.mock.calls[0][1];
    expect(params[params.length - 1]).toBe(CREATIONS_PAGE_MAX + 1);
  });

  it("emits a next cursor and hasMore when another page exists", async () => {
    // limit + 1 rows come back, so there is more.
    const rows = Array.from({ length: CREATIONS_PAGE_DEFAULT + 1 }, (_, i) => row(i));
    db.query.mockResolvedValue({ rows, rowCount: rows.length });

    const res = await request(app)
      .get("/api/creations")
      .set("Authorization", `Bearer ${userToken()}`);

    expect(res.body).toHaveLength(CREATIONS_PAGE_DEFAULT); // the extra is trimmed
    expect(res.headers["x-has-more"]).toBe("true");
    expect(res.headers["x-next-cursor"]).toEqual(expect.any(String));
    expect(res.headers["access-control-expose-headers"]).toContain("X-Next-Cursor");
  });

  it("reports hasMore=false and no cursor on the last page", async () => {
    db.query.mockResolvedValue({ rows: [row(1)], rowCount: 1 });
    const res = await request(app)
      .get("/api/creations")
      .set("Authorization", `Bearer ${userToken()}`);

    expect(res.headers["x-has-more"]).toBe("false");
    expect(res.headers["x-next-cursor"]).toBeUndefined();
  });

  it("round-trips its own cursor into a keyset predicate", async () => {
    const rows = Array.from({ length: CREATIONS_PAGE_DEFAULT + 1 }, (_, i) => row(i));
    db.query.mockResolvedValue({ rows, rowCount: rows.length });

    const first = await request(app)
      .get("/api/creations")
      .set("Authorization", `Bearer ${userToken()}`);

    db.query.mockClear();
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });

    const second = await request(app)
      .get(`/api/creations?cursor=${encodeURIComponent(first.headers["x-next-cursor"])}`)
      .set("Authorization", `Bearer ${userToken()}`);

    expect(second.status).toBe(200);
    const sql = db.query.mock.calls[0][0];
    // The row-value comparison is what lets Postgres drive the composite index
    // directly, so a deep page costs the same as a shallow one.
    expect(sql).toContain("(created_at, id) <");
  });

  it("rejects a tampered cursor with 400 rather than silently restarting", async () => {
    const res = await request(app)
      .get("/api/creations?cursor=!!!not-a-cursor!!!")
      .set("Authorization", `Bearer ${userToken()}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });

  it("cannot be used to read another user's rows - the cursor never carries a user id", async () => {
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });
    await request(app)
      .get("/api/creations")
      .set("Authorization", `Bearer ${userToken()}`);

    // user_id is always $1, taken from the verified token, never from input.
    expect(db.query.mock.calls[0][1][0]).toBe(USER);
  });
});

describe("SEC-9.3 — recommendation limit is clamped", () => {
  const recommendationService = require("../../src/services/recommendationService");

  it("clamps ?limit to the configured maximum", async () => {
    const spy = jest
      .spyOn(recommendationService, "getSimilarStyles")
      .mockResolvedValue([]);

    await request(app)
      .get(`/api/styles/${STYLE}/similar?limit=99999999`)
      .set("Authorization", `Bearer ${userToken()}`);

    expect(spy).toHaveBeenCalledWith({
      styleId: STYLE,
      limit: RECOMMENDATION_LIMIT_MAX,
    });
    spy.mockRestore();
  });

  it("leaves a reasonable limit untouched", async () => {
    const spy = jest
      .spyOn(recommendationService, "getSimilarStyles")
      .mockResolvedValue([]);

    await request(app)
      .get(`/api/styles/${STYLE}/similar?limit=5`)
      .set("Authorization", `Bearer ${userToken()}`);

    expect(spy).toHaveBeenCalledWith({ styleId: STYLE, limit: 5 });
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// SEC-3.1 (transport-level: the header must be inert when absent)
// ---------------------------------------------------------------------------

describe("SEC-3.1 — no Idempotency-Key means no behaviour change", () => {
  it("does not touch the idempotency table when the header is absent", async () => {
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });

    await request(app)
      .get("/api/creations")
      .set("Authorization", `Bearer ${userToken()}`);

    const touched = db.query.mock.calls.some((c) =>
      String(c[0]).includes("generation_idempotency")
    );
    expect(touched).toBe(false);
  });
});
