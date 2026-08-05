"use strict";

/**
 * Sprint 3 / H-1 + H-2 — the process lifecycle.
 *
 * Both of these were absent, and both were absent in a way that produced no
 * error message when they bit:
 *
 *   H-1  Railway sends SIGTERM on every deploy. With no handler, Node
 *        terminates immediately, killing in-flight requests - including
 *        generations that had ALREADY deducted credits and had not yet reached
 *        their refund. There is no reconciliation job that would ever find one.
 *
 *   H-2  `pg` emits `error` on the POOL for idle-client failures. An `error`
 *        event with no listener is re-thrown as an uncaught exception, which
 *        kills the process. Supabase's pooler recycles idle connections
 *        routinely, so this was a scheduled crash.
 *
 * server.js is deliberately NOT required here: importing it binds a port and
 * registers real signal handlers on the jest process. What is asserted is the
 * behaviour of the pieces it wires together, plus the wiring itself by reading
 * the file - which is enough to catch the regression that matters (someone
 * deleting the handler).
 */

const fs = require("fs");
const path = require("path");

const SERVER_SOURCE = fs.readFileSync(
  path.join(__dirname, "..", "..", "server.js"),
  "utf8"
);

describe("H-1: graceful shutdown is wired up", () => {
  it("handles SIGTERM - the signal every deploy sends", () => {
    expect(SERVER_SOURCE).toMatch(/process\.on\(\s*["']SIGTERM["']/);
  });

  it("handles SIGINT", () => {
    expect(SERVER_SOURCE).toMatch(/process\.on\(\s*["']SIGINT["']/);
  });

  it("stops accepting connections before closing the pool", () => {
    // Ordering is load-bearing: an in-flight request that is still finishing
    // needs its database connection, so ending the pool first would break the
    // very requests the drain exists to protect.
    const closeIndex = SERVER_SOURCE.indexOf("server.close(");
    const poolEndIndex = SERVER_SOURCE.indexOf("db.pool.end(");

    expect(closeIndex).toBeGreaterThan(-1);
    expect(poolEndIndex).toBeGreaterThan(-1);
    expect(closeIndex).toBeLessThan(poolEndIndex);
  });

  it("bounds the drain with a grace period", () => {
    expect(SERVER_SOURCE).toMatch(/SHUTDOWN_GRACE_PERIOD_MS/);
  });

  it("sets keep-alive timeouts longer than the proxy's", () => {
    // Node's 5s default is shorter than a typical proxy keep-alive, which
    // produces sporadic 502s that only reproduce under load.
    expect(SERVER_SOURCE).toMatch(/server\.keepAliveTimeout\s*=/);
    expect(SERVER_SOURCE).toMatch(/server\.headersTimeout\s*=/);
  });

  it("keeps headersTimeout above keepAliveTimeout", () => {
    const keepAlive = SERVER_SOURCE.match(/keepAliveTimeout\s*=\s*[^|]*\|\|\s*([\d_]+)/);
    const headers = SERVER_SOURCE.match(/headersTimeout\s*=\s*[^|]*\|\|\s*([\d_]+)/);

    expect(keepAlive).not.toBeNull();
    expect(headers).not.toBeNull();

    const keepAliveMs = Number(keepAlive[1].replace(/_/g, ""));
    const headersMs = Number(headers[1].replace(/_/g, ""));

    // Node closes the socket while still reading headers otherwise.
    expect(headersMs).toBeGreaterThan(keepAliveMs);
  });
});

describe("H-2: the crash handlers exist", () => {
  it("records an uncaught exception before exiting", () => {
    expect(SERVER_SOURCE).toMatch(/process\.on\(\s*["']uncaughtException["']/);
    expect(SERVER_SOURCE).toMatch(/uncaught_exception/);
  });

  it("records an unhandled rejection", () => {
    expect(SERVER_SOURCE).toMatch(/process\.on\(\s*["']unhandledRejection["']/);
  });

  it("does NOT exit on an unhandled rejection", () => {
    // A rejected promise usually leaves the process healthy - the common cause
    // is a forgotten .catch() on a background task - and killing production
    // over one is worse than the bug. Assert the comment-documented decision
    // by checking the handler body has no exit call.
    const start = SERVER_SOURCE.indexOf('process.on("unhandledRejection"');
    const end = SERVER_SOURCE.indexOf("checkPendingMigrations()", start);
    const body = SERVER_SOURCE.slice(start, end);

    expect(body).not.toMatch(/process\.exit/);
  });

  it("exits non-zero on an uncaught exception so the platform restarts", () => {
    const start = SERVER_SOURCE.indexOf('process.on("uncaughtException"');
    const end = SERVER_SOURCE.indexOf('process.on("unhandledRejection"', start);
    const body = SERVER_SOURCE.slice(start, end);

    expect(body).toMatch(/process\.exit\(1\)/);
  });
});

describe("H-2: the pg pool has an error listener", () => {
  const DB_SOURCE = fs.readFileSync(
    path.join(__dirname, "..", "config", "db.js"),
    "utf8"
  );

  it("registers pool.on('error')", () => {
    // Its ABSENCE is the bug: Node re-throws an unhandled 'error' event as an
    // uncaught exception, so no listener meant an idle-connection drop killed
    // the API.
    expect(DB_SOURCE).toMatch(/pool\.on\(\s*["']error["']/);
  });

  it("does not rethrow from the listener", () => {
    const start = DB_SOURCE.indexOf('pool.on("error"');
    const end = DB_SOURCE.indexOf("withStatementTimeout", start);
    const body = DB_SOURCE.slice(start, end);

    // pg discards the broken client itself and the next query opens a new one.
    // Rethrowing would reintroduce exactly the crash this fixes.
    expect(body).not.toMatch(/throw\s/);
  });

  it("logs the pg error code but not the error object", () => {
    const start = DB_SOURCE.indexOf('pool.on("error"');
    const end = DB_SOURCE.indexOf("withStatementTimeout", start);
    const body = DB_SOURCE.slice(start, end);

    expect(body).toMatch(/err\.code/);
    // SEC-7.3: a pg error can carry the last query and its parameters, which
    // is user content.
    expect(body).not.toMatch(/\.\.\.err|JSON\.stringify\(err\)/);
  });
});

describe("the actual pool wiring", () => {
  it("attaches exactly one error listener at import time", () => {
    jest.isolateModules(() => {
      const db = require("../config/db");
      expect(db.pool.listenerCount("error")).toBe(1);
    });
  });

  it("survives an emitted idle-client error without throwing", () => {
    jest.isolateModules(() => {
      const db = require("../config/db");

      // Before the fix this line would have terminated the process.
      expect(() => {
        const err = new Error("Connection terminated unexpectedly");
        err.code = "57P01";
        db.pool.emit("error", err);
      }).not.toThrow();
    });
  });
});
