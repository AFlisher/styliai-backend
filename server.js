require('dotenv').config();

// SEC-17.1: assert signing-secret quality before anything is served. This lives
// in the entrypoint rather than in the middleware that consumes the secret so
// that it runs exactly once, on the real boot path, and never against the
// throwaway secrets the test suite sets.
// SEC-15.2 adds MFA_ENCRYPTION_KEY on the same principle: a bad key must stop
// the boot, not surface later as an enrolled admin who cannot log in.
const { validateAdminJwtSecret, validateMfaEncryptionKey } = require('./src/config/validateSecrets');
validateAdminJwtSecret();
validateMfaEncryptionKey();

const app = require("./src/app");
const db = require("./src/config/db");
const { logger } = require("./src/utils/logger");
const alerting = require("./src/utils/alerting");
const { checkPendingMigrations } = require("./src/utils/migrationStatus");

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
    logger.info("server_started", { port: Number(PORT), pid: process.pid });
    console.log(`🚀 StyliAI Server is running on port ${PORT}`);
});

// ─── Sprint 3 / H-1: socket timeouts ────────────────────────────────────────
//
// Node's default keepAliveTimeout is 5s. Behind a proxy that holds its own
// keep-alive open longer, the race is real and well documented: the proxy
// reuses a connection at the moment Node is closing it, and the client sees a
// sporadic 502 that reproduces under load and nowhere else. Railway puts this
// app behind two hops (see src/app.js), so the window is two hops wide.
//
// The rule is that ours must be LONGER than the proxy's. 65s is the
// conventional value for exactly this reason, and headersTimeout must exceed
// keepAliveTimeout or Node closes the socket while still reading the headers
// of a request it just agreed to keep alive for.
server.keepAliveTimeout = Number(process.env.SERVER_KEEPALIVE_TIMEOUT_MS) || 65_000;
server.headersTimeout = Number(process.env.SERVER_HEADERS_TIMEOUT_MS) || 70_000;

// ─── Sprint 3 / H-1: graceful shutdown ──────────────────────────────────────
//
// Before this, the entrypoint was `app.listen` and nothing else. Railway sends
// SIGTERM on every single deploy, and Node's default action is to terminate
// immediately - so every deploy killed whatever was in flight.
//
// That is not merely a dropped request. `stabilityController` and
// `generateController` deduct credits BEFORE calling the paid provider and
// refund them in a catch block; a SIGTERM between those two points commits the
// deduction and never runs the refund. Generation legitimately takes 10-40s,
// so the window is wide, it is hit on every deploy, and there is no
// reconciliation job that would ever find the stranded charge.
//
// Draining is therefore about money, not tidiness.
const SHUTDOWN_GRACE_MS = Number(process.env.SHUTDOWN_GRACE_PERIOD_MS) || 30_000;

let shuttingDown = false;

async function shutdown(signal) {
  // A second signal must not start a second shutdown - and must not be treated
  // as "the operator is impatient, exit now" either, because that is precisely
  // the impatience that strands a charge.
  if (shuttingDown) {
    logger.warn("shutdown_signal_ignored", { signal, reason: "already_shutting_down" });
    return;
  }
  shuttingDown = true;

  logger.info("shutdown_started", { signal, graceMs: SHUTDOWN_GRACE_MS });

  // Stop accepting new connections. In-flight requests keep running: the
  // callback fires once the last one finishes.
  const closed = new Promise((resolve) => server.close(() => resolve("drained")));

  const timedOut = new Promise((resolve) =>
    setTimeout(() => resolve("timeout"), SHUTDOWN_GRACE_MS).unref()
  );

  const outcome = await Promise.race([closed, timedOut]);

  if (outcome === "timeout") {
    // Worth an alert, not just a log. Requests still running after the grace
    // period are about to be killed mid-flight, which is the exact scenario
    // this shutdown path exists to prevent - so if it happens, the grace
    // period is wrong for the workload and someone needs to know.
    alerting.raise("shutdown_grace_exceeded", {
      severity: alerting.SEVERITY.ERROR,
      message:
        `Requests were still in flight after ${SHUTDOWN_GRACE_MS}ms; ` +
        "connections are being closed mid-request. A generation may have been " +
        "charged without being delivered.",
      context: { signal, graceMs: SHUTDOWN_GRACE_MS },
    });
  } else {
    logger.info("shutdown_drained", { signal });
  }

  // The pool goes last: an in-flight request that is still finishing needs its
  // connection, so closing the pool first would break the very requests the
  // drain above was protecting.
  try {
    await db.pool.end();
    logger.info("shutdown_pool_closed", {});
  } catch (err) {
    logger.error("shutdown_pool_close_failed", { error: (err && err.message) || "unknown" });
  }

  logger.info("shutdown_complete", { signal });

  // Explicit exit rather than falling off the end of the event loop: a stray
  // unref'd timer or an open keep-alive socket would otherwise hold the
  // process open past the platform's own kill deadline, turning a graceful
  // shutdown into a SIGKILL.
  process.exit(0);
}

// SIGTERM is what Railway, Docker and Kubernetes all send. SIGINT is Ctrl-C.
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ─── Sprint 3 / H-2: the crashes nobody was watching ────────────────────────
//
// A repository-wide search for `process.on`, `uncaughtException` and
// `unhandledRejection` returned nothing outside test files. Both of these
// terminate the process by default in modern Node, so the service was already
// exiting on them - silently, with no record of why, and with whatever was in
// flight discarded.
//
// The handlers do not swallow. An uncaught exception leaves the process in an
// undefined state and Node's own guidance is to exit; what changes here is that
// it is recorded and alerted FIRST, and that the exit goes through the same
// drain as a deploy so in-flight work gets its chance to finish.
process.on("uncaughtException", (err) => {
  alerting.raise("uncaught_exception", {
    severity: alerting.SEVERITY.CRITICAL,
    message: `Uncaught exception: ${(err && err.message) || "unknown"}`,
    context: { name: (err && err.name) || "Error" },
  });
  logger.error("uncaught_exception", {
    name: (err && err.name) || "Error",
    message: (err && err.message) || "unknown",
    stack: (err && typeof err.stack === "string" ? err.stack : "").split("\n").slice(0, 8).join("\n"),
  });

  // Exit code 1 so the platform restarts and does not mistake this for a clean
  // stop. The drain still runs - it is the same code path as a deploy.
  shutdown("uncaughtException").finally(() => process.exit(1));
});

process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);

  alerting.raise("unhandled_rejection", {
    severity: alerting.SEVERITY.CRITICAL,
    message: `Unhandled promise rejection: ${message}`,
    context: {},
  });
  logger.error("unhandled_rejection", {
    message,
    stack:
      reason instanceof Error && typeof reason.stack === "string"
        ? reason.stack.split("\n").slice(0, 8).join("\n")
        : undefined,
  });

  // Deliberately does NOT exit. Unlike an uncaught exception, a rejected
  // promise usually leaves the process perfectly healthy - the common cause is
  // a forgotten `.catch()` on a background task - and killing production for
  // one is a worse outcome than the bug itself. It is loud instead.
});

// ─── Sprint 3 / H-9: pending-migration gate ─────────────────────────────────
//
// The backend auto-deploys from `main` while `npm run migrate` is a manual
// step, so a commit whose code needs a new column can reach production before
// the column does. This does not apply DDL on boot - that would run
// concurrently on every replica and make a deploy capable of altering the
// schema by accident - it CHECKS, and reports the answer through /readyz,
// which is what gates traffic.
checkPendingMigrations()
  .then((status) => {
    if (status.pending.length > 0) {
      alerting.raise("migrations_pending", {
        severity: alerting.SEVERITY.CRITICAL,
        message:
          `${status.pending.length} migration(s) have never been applied to this ` +
          "database. The service is serving code that expects a schema it does " +
          "not have. Run `npm run migrate`.",
        context: { pending: status.pending.slice(0, 10) },
      });
    } else if (status.checked) {
      logger.info("migrations_up_to_date", { applied: status.applied });
    }
  })
  .catch((err) => {
    // A failed check is not a failed boot. It is reported and the service
    // starts - refusing to serve because we could not read a bookkeeping table
    // would turn an observability gap into an outage.
    logger.warn("migration_check_failed", { error: (err && err.message) || "unknown" });
  });

module.exports = { server, shutdown };
