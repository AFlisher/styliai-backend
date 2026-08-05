"use strict";

/**
 * Phase 5 — production health endpoints.
 *
 * SEC-20.3 recorded that there was no health endpoint at all, which had a
 * second cost beyond monitoring: there was no way to tell from outside which
 * build Railway was serving, so every deploy verification in this project has
 * had to rely on side effects (a route appearing, a middleware reordering).
 *
 * Two endpoints, because they answer different questions:
 *
 *   /healthz  liveness  - is this process up? No dependency checks, so a
 *                         database blip never causes a restart loop.
 *   /readyz   readiness - can it actually serve? Checks the database and
 *                         storage, and returns 503 when it cannot.
 *
 * ─── What these deliberately do not say ──────────────────────────────────
 *
 * Both are unauthenticated, so neither may leak anything an attacker can use.
 * No versions, no hostnames, no connection strings, no error text from a failed
 * dependency check, no table or bucket names beyond the fixed labels below. A
 * failing dependency reports `false` and nothing else; the reason goes to the
 * log stream, which is authenticated by virtue of not being public.
 */

const db = require("../config/db");
const { logger } = require("../utils/logger");
const metrics = require("../utils/metrics");

/** A dependency check must never hang a health probe. */
const CHECK_TIMEOUT_MS = 2000;

function withTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} check timed out`)), CHECK_TIMEOUT_MS)
    ),
  ]);
}

/**
 * Liveness. Answers only "is this process running", so it must not depend on
 * anything external - a readiness failure that restarts the container turns a
 * transient database problem into an outage.
 */
function healthz(req, res) {
  res.set("Cache-Control", "no-store");
  return res.status(200).json({ status: "ok", uptimeSeconds: Math.round(process.uptime()) });
}

/**
 * Readiness. Reports each dependency as a bare boolean.
 *
 * The storage check is a bucket metadata read rather than an object read: it
 * proves credentials and reachability without touching user content.
 */
async function readyz(req, res) {
  // Sprint 3 / H-9: `migrations` joins the dependency checks because a schema
  // behind the code it is serving is not a degraded instance, it is a broken
  // one - it will 500 on whichever endpoint touches the missing column. Making
  // it a readiness signal is what holds traffic off a half-migrated deploy,
  // and it is the one dependency here that a restart cannot fix.
  const checks = { database: false, storage: false, migrations: false };

  try {
    await withTimeout(db.query("SELECT 1"), "database");
    checks.database = true;
  } catch (err) {
    logger.warn("health_check_failed", {
      requestId: req.id,
      dependency: "database",
      message: (err && err.message) || "unknown",
    });
  }

  try {
    // Required lazily rather than at module load. config/supabase now defers
    // its own client construction to first use (see that file), so this is no
    // longer load-bearing for correctness the way it once was - but a health
    // check still has no reason to pull in anything before it is actually
    // asked to check, so the lazy require stays.
    const supabase = require("../config/supabase");
    const { error } = await withTimeout(supabase.storage.getBucket("avatars"), "storage");
    if (error) throw new Error(error.message);
    checks.storage = true;
  } catch (err) {
    logger.warn("health_check_failed", {
      requestId: req.id,
      dependency: "storage",
      message: (err && err.message) || "unknown",
    });
  }

  try {
    const { checkPendingMigrations } = require("../utils/migrationStatus");
    const status = await withTimeout(checkPendingMigrations(), "migrations");

    // `checked: false` means we could not read the ledger, not that the schema
    // is behind. Reporting true there is deliberate: a readiness probe that
    // fails closed on its own inability to introspect would take the service
    // down over a bookkeeping table.
    checks.migrations = !status.checked || status.pending.length === 0;

    if (status.checked && status.pending.length > 0) {
      logger.error("readyz_migrations_pending", {
        requestId: req.id,
        pendingCount: status.pending.length,
      });
    }
  } catch (err) {
    checks.migrations = true;
    logger.warn("health_check_failed", {
      requestId: req.id,
      dependency: "migrations",
      message: (err && err.message) || "unknown",
    });
  }

  const ready = Object.values(checks).every(Boolean);
  res.set("Cache-Control", "no-store");
  return res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "degraded", checks });
}

/**
 * Monitoring counters for this process.
 *
 * Behind admin auth, unlike the two above. Request volumes, error rates and
 * per-event counters describe the shape of production traffic, which is not
 * something to hand to an anonymous caller - and the auth/authz failure
 * counters in particular would tell an attacker whether their probing is
 * being noticed.
 *
 * `scope` is stated in the payload because these numbers cover ONE process
 * since its last restart, and Railway's replica count is unknown. A number that
 * looks fleet-wide and is not is worse than no number.
 */
function metricsSnapshot(req, res) {
  res.set("Cache-Control", "no-store");
  return res.status(200).json({
    scope: "single_process_since_restart",
    ...metrics.snapshot(),
  });
}

module.exports = { healthz, readyz, metricsSnapshot };
