"use strict";

/**
 * Phase 5 — structured logging, correlation ids, health, metrics.
 *
 * Assertions are made on what is actually WRITTEN to the streams, parsed as
 * JSON, rather than on a console spy. A spy proves a function was called; it
 * does not prove the line is machine-readable, which is the entire point of
 * this work. It also means the "never log a secret" assertions are made against
 * the real output, the only place that guarantee is worth anything.
 */

process.env.SUPABASE_JWT_SECRET = "test-only-secret-never-used-in-production";
process.env.ADMIN_JWT_SECRET =
  process.env.ADMIN_JWT_SECRET || "test-only-secret-never-used-in-production";

jest.mock("../config/db", () => ({
  query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  pool: { connect: jest.fn() },
}));
// Phase 6: the auth middlewares now read session state per request. See the
// helper for why this is mocked rather than queued into each db.query stub.
jest.mock("../services/sessionService", () => require("../../test/mocks/activeSession"));

const request = require("supertest");
const jwt = require("jsonwebtoken");
const db = require("../config/db");
const app = require("../app");
const { logger, redactFields } = require("../utils/logger");
const metrics = require("../utils/metrics");
const { sanitizeInboundId } = require("../middleware/requestContext");

const USER_ID = "f60f71b5-be64-43d4-b747-e2dadd8787f7";

function userToken() {
  return jwt.sign(
    { sub: USER_ID, aud: "authenticated", type: "access" },
    process.env.SUPABASE_JWT_SECRET,
    { algorithm: "HS256", expiresIn: "5m" }
  );
}

/** Captures both streams, since warn/error go to stderr and the rest to stdout. */
async function capture(fn) {
  const chunks = [];
  const realOut = process.stdout.write;
  const realErr = process.stderr.write;
  const saved = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = "debug";
  process.stdout.write = (c) => (chunks.push(String(c)), true);
  process.stderr.write = (c) => (chunks.push(String(c)), true);
  try {
    await fn();
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
    if (saved === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = saved;
  }
  return chunks.join("");
}

function lines(log) {
  return log
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

const find = (log, event) => lines(log).find((l) => l.event === event);

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockResolvedValue({ rows: [], rowCount: 0 });
  metrics.reset();
});

describe("every line is structured", () => {
  it("writes one parseable JSON object per log line", async () => {
    const log = await capture(() => request(app).get("/api/this-does-not-exist"));

    const raw = log.split("\n").filter(Boolean);
    expect(raw.length).toBeGreaterThan(0);
    for (const line of raw) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("carries a timestamp, level and event on every line", async () => {
    const log = await capture(() => request(app).get("/"));

    for (const line of lines(log)) {
      expect(line.ts).toEqual(expect.any(String));
      expect(["debug", "info", "warn", "error"]).toContain(line.level);
      expect(line.event).toEqual(expect.any(String));
    }
  });

  it("records method, path, status, duration, ip and user agent for a request", async () => {
    const log = await capture(() =>
      request(app).get("/api/this-does-not-exist").set("User-Agent", "probe/1.0")
    );

    const line = find(log, "http_request");
    expect(line).toMatchObject({
      method: "GET",
      path: "/api/this-does-not-exist",
      status: 404,
      userAgent: "probe/1.0",
    });
    expect(typeof line.durationMs).toBe("number");
    expect(line.ip).toEqual(expect.any(String));
  });

  it("records the authenticated user id when the request carried one", async () => {
    const log = await capture(() =>
      request(app).get("/api/creations").set("Authorization", `Bearer ${userToken()}`)
    );

    expect(find(log, "http_request").userId).toBe(USER_ID);
  });

  it("logs no user id for an anonymous request", async () => {
    const log = await capture(() => request(app).get("/"));

    expect(find(log, "http_request").userId).toBeUndefined();
  });
});

describe("correlation ids", () => {
  it("returns one in X-Request-Id and repeats it in the log line", async () => {
    let res;
    const log = await capture(async () => {
      res = await request(app).get("/api/this-does-not-exist");
    });

    const id = res.headers["x-request-id"];
    expect(id).toEqual(expect.any(String));
    expect(find(log, "http_request").requestId).toBe(id);
  });

  it("puts the same id in the error body, so a user can quote it", async () => {
    const res = await request(app).get("/api/this-does-not-exist");

    expect(res.body.requestId).toBe(res.headers["x-request-id"]);
  });

  it("joins every line written for one request", async () => {
    // The property that makes the id worth having: an operator holding one id
    // gets the whole story, not one line of it.
    const log = await capture(() => request(app).get("/api/creations"));

    const ids = new Set(lines(log).filter((l) => l.requestId).map((l) => l.requestId));
    expect(ids.size).toBe(1);
    expect(lines(log).filter((l) => l.requestId).length).toBeGreaterThan(1);
  });

  it("honours a well-formed inbound id so an edge trace survives", async () => {
    const res = await request(app)
      .get("/api/this-does-not-exist")
      .set("X-Request-Id", "edge-trace-abc123");

    expect(res.headers["x-request-id"]).toBe("edge-trace-abc123");
  });

  it("replaces a malformed inbound id rather than echoing it", () => {
    // It is written into every log line and echoed in a response header, so an
    // unbounded or control-character value is both a log-injection and a
    // header-splitting vector.
    expect(sanitizeInboundId("short")).toBeNull();
    expect(sanitizeInboundId("x".repeat(65))).toBeNull();
    expect(sanitizeInboundId("has spaces here")).toBeNull();
    expect(sanitizeInboundId("bad\r\nInjected: yes")).toBeNull();
    expect(sanitizeInboundId('"quoted-value"')).toBeNull();
    expect(sanitizeInboundId("good-id_12345")).toBe("good-id_12345");
  });

  it("does not echo an injected header value", async () => {
    const res = await request(app)
      .get("/api/this-does-not-exist")
      .set("X-Request-Id", "abcdefgh injected");

    expect(res.headers["x-request-id"]).not.toContain("injected");
  });
});

describe("secrets never reach the log stream", () => {
  it("redacts credential-shaped keys at every depth", () => {
    const out = redactFields({
      password: "hunter2",
      nested: { refreshToken: "rt", apiKey: "ak", safe: "keep" },
      list: [{ authorization: "Bearer x" }],
    });

    expect(JSON.stringify(out)).not.toContain("hunter2");
    expect(JSON.stringify(out)).not.toContain("Bearer x");
    expect(out.nested.safe).toBe("keep");
  });

  it("summarises a Buffer instead of serialising image bytes", () => {
    const out = redactFields({ image: Buffer.from([1, 2, 3, 4]) });

    expect(out.image).toBe("[buffer 4b]");
  });

  it("survives a circular object rather than throwing", () => {
    // The logger runs on the response path; a throw here would turn a served
    // request into an uncaught exception.
    const circular = { name: "x" };
    circular.self = circular;

    expect(() => redactFields(circular)).not.toThrow();
    expect(() => logger.info("probe", circular)).not.toThrow();
  });

  it("redacts credential-bearing query parameters from the logged path", async () => {
    // Added after a vacuity probe: breaking redactUrl in requestLogger failed
    // the SEC-16.1 suite but left this one entirely green, so the new logger's
    // own suite was not pinning the property it inherited. It is now, because
    // the redaction moved into this middleware and this is where a future
    // change to it will be made.
    const secret = "11111111-2222-3333-4444-555555555555";
    const log = await capture(() => request(app).get(`/api/auth/verify?token=${secret}`));

    expect(log).not.toContain(secret);
    expect(find(log, "http_request").path).toContain("token=[REDACTED]");
  });

  it("does not write an Authorization header value", async () => {
    const token = userToken();
    const log = await capture(() =>
      request(app).get("/api/creations").set("Authorization", `Bearer ${token}`)
    );

    expect(log).not.toContain(token);
  });

  it("bounds an oversized line instead of writing it whole", async () => {
    const huge = "A".repeat(50_000);
    const log = await capture(() => logger.info("probe_big", { blob: huge }));

    expect(log).not.toContain(huge);
    expect(find(log, "probe_big").note).toBe("truncated");
  });
});

describe("security events", () => {
  it("logs an authentication failure with a reason and no token", async () => {
    const log = await capture(() =>
      request(app).get("/api/creations").set("Authorization", "Bearer not-a-real-token")
    );

    const line = find(log, "auth_failure");
    expect(line.reason).toBe("invalid_token");
    expect(log).not.toContain("not-a-real-token");
  });

  it("distinguishes a missing header from a bad token", async () => {
    const log = await capture(() => request(app).get("/api/creations"));

    expect(find(log, "auth_failure").reason).toBe("no_header");
  });

  it("logs an authorization failure with the roles involved", async () => {
    const viewer = jwt.sign(
      { sub: "admin-1", role: "admin", adminRole: "viewer" },
      process.env.ADMIN_JWT_SECRET,
      { algorithm: "HS256", expiresIn: "5m" }
    );

    const log = await capture(() =>
      request(app)
        .post("/api/admin/users/00000000-0000-0000-0000-000000000000/adjust-balance")
        .set("Authorization", `Bearer ${viewer}`)
        .send({ amount: 1 })
    );

    const line = find(log, "authz_failure");
    expect(line).toMatchObject({ reason: "insufficient_role", required: "superadmin", actual: "viewer" });
  });

  it("logs an upload failure with the stage that refused it", async () => {
    const log = await capture(() =>
      request(app)
        .post("/api/profile/avatar")
        .set("Authorization", `Bearer ${userToken()}`)
        .attach("avatar", Buffer.from("<html>not an image</html>"), {
          filename: "a.jpg",
          contentType: "image/jpeg",
        })
    );

    expect(find(log, "upload_failure").stage).toBe("magic_bytes");
  });

  it("never exposes an internal error message to the client", async () => {
    db.query.mockRejectedValue(new Error("db exploded with secret-detail"));
    jest.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(app)
      .get("/api/creations")
      .set("Authorization", `Bearer ${userToken()}`);

    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain("secret-detail");
    expect(JSON.stringify(res.body)).not.toMatch(/stack|at Object|\.js:\d+/);
    console.error.mockRestore();
  });

  it("attaches the correlation id to EVERY response, however the error was handled", async () => {
    // The guarantee is the header, not the body. Controllers that build their
    // own 500 (creationsController and several others predate this work) never
    // reach the global handler, so their body carries no requestId - but the
    // header is set by requestContext before any route runs, so it is present
    // on every response including theirs. A user quoting the header is always
    // enough to find the server-side line.
    db.query.mockRejectedValue(new Error("db exploded"));
    jest.spyOn(console, "error").mockImplementation(() => {});

    const selfHandled = await request(app)
      .get("/api/creations")
      .set("Authorization", `Bearer ${userToken()}`);
    const globalHandler = await request(app).get("/api/this-does-not-exist");

    expect(selfHandled.status).toBe(500);
    expect(selfHandled.headers["x-request-id"]).toEqual(expect.any(String));
    expect(globalHandler.headers["x-request-id"]).toEqual(expect.any(String));
    // The global handler additionally puts it in the body.
    expect(globalHandler.body.requestId).toBe(globalHandler.headers["x-request-id"]);
    console.error.mockRestore();
  });

  it("logs an unexpected exception through the global handler with its id", async () => {
    const log = await capture(async () => {
      await request(app).get("/api/this-does-not-exist");
    });

    // The 404 path proves the correlated envelope end to end without needing a
    // controller that throws.
    const line = find(log, "http_request");
    expect(line.requestId).toEqual(expect.any(String));
    expect(line.status).toBe(404);
  });
});

describe("health endpoints", () => {
  it("reports liveness without touching any dependency", async () => {
    db.query.mockRejectedValue(new Error("database is down"));

    const res = await request(app).get("/healthz");

    // Liveness must not depend on the database, or a blip becomes a restart
    // loop that turns a transient fault into an outage.
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(db.query).not.toHaveBeenCalled();
  });

  it("is never cached", async () => {
    const res = await request(app).get("/healthz");

    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("reports readiness as bare booleans", async () => {
    const res = await request(app).get("/readyz");

    expect(res.body.checks).toEqual({
      database: expect.any(Boolean),
      storage: expect.any(Boolean),
    });
  });

  it("answers 503 when a dependency is down", async () => {
    db.query.mockRejectedValue(new Error("connection refused"));

    const res = await request(app).get("/readyz");

    expect(res.status).toBe(503);
    expect(res.body.checks.database).toBe(false);
  });

  it("leaks nothing about why a dependency failed", async () => {
    // Unauthenticated endpoint: a failure reason names infrastructure, and the
    // reason belongs in the log stream, not in a public response.
    db.query.mockRejectedValue(new Error("password authentication failed for user postgres"));

    const res = await request(app).get("/readyz");
    const body = JSON.stringify(res.body);

    expect(body).not.toContain("postgres");
    expect(body).not.toContain("password");
    expect(body).not.toMatch(/supabase|railway|host|port/i);
  });

  it("requires no credentials, so a platform probe can reach it", async () => {
    expect((await request(app).get("/healthz")).status).toBe(200);
  });
});

describe("monitoring counters", () => {
  it("counts requests by status class", async () => {
    await request(app).get("/");
    await request(app).get("/api/this-does-not-exist");

    const snap = metrics.snapshot();
    expect(snap.requests.total).toBeGreaterThanOrEqual(2);
    expect(snap.requests.byStatusClass["2xx"]).toBeGreaterThanOrEqual(1);
    expect(snap.requests.byStatusClass["4xx"]).toBeGreaterThanOrEqual(1);
  });

  it("records latency into bounded buckets, never raw samples", async () => {
    await request(app).get("/");

    const snap = metrics.snapshot();
    expect(snap.latency.count).toBeGreaterThanOrEqual(1);
    expect(Object.keys(snap.latency.buckets)).toContain("le_inf");
    // Bounded by construction: an unbounded array of every request's duration
    // is a memory leak with extra steps.
    expect(snap.latency).not.toHaveProperty("samples");
  });

  it("counts authentication failures", async () => {
    await request(app).get("/api/creations");

    expect(metrics.snapshot().events.auth_failures).toBeGreaterThanOrEqual(1);
  });

  it("counts upload failures", async () => {
    await request(app)
      .post("/api/profile/avatar")
      .set("Authorization", `Bearer ${userToken()}`)
      .attach("avatar", Buffer.from("nope"), { filename: "a.jpg", contentType: "image/jpeg" });

    expect(metrics.snapshot().events.upload_failures).toBeGreaterThanOrEqual(1);
  });

  it("ignores a caller-derived counter name, which would be unbounded", () => {
    metrics.increment("x".repeat(65));
    metrics.increment("");

    expect(Object.keys(metrics.snapshot().events)).toHaveLength(0);
  });

  it("exposes the snapshot only to an authenticated admin", async () => {
    const anon = await request(app).get("/api/admin/metrics");

    expect(anon.status).toBe(401);
  });

  it("states that the numbers are per-process", async () => {
    const viewer = jwt.sign(
      { sub: "admin-1", role: "admin", adminRole: "viewer" },
      process.env.ADMIN_JWT_SECRET,
      { algorithm: "HS256", expiresIn: "5m" }
    );

    const res = await request(app)
      .get("/api/admin/metrics")
      .set("Authorization", `Bearer ${viewer}`);

    expect(res.status).toBe(200);
    // A number that looks fleet-wide and is not is worse than no number.
    expect(res.body.scope).toBe("single_process_since_restart");
  });
});
