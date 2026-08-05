"use strict";

const db = require("../config/db");

/**
 * Sprint 3 / H-9 — is this database actually carrying the schema this code
 * expects?
 *
 * ─── The gap ────────────────────────────────────────────────────────────────
 *
 * The backend auto-deploys from `main`; `npm run migrate` is a human step. So a
 * commit whose code needs a new column can - and eventually will - reach
 * production before the column does. The failure is not a clean boot error: the
 * service starts perfectly and then throws 500s on whichever endpoint touches
 * the missing column, which looks like an application bug rather than a
 * half-finished deploy.
 *
 * ─── Why this only reads ────────────────────────────────────────────────────
 *
 * The tempting fix is to run migrations on boot. That is worse. Every replica
 * would race the same DDL, and a deploy would gain the power to alter the
 * schema as a side effect of restarting - which is precisely the property that
 * makes `runMigration.js`'s deliberate, human-invoked design safe. This
 * compares the schedule against the `schema_migrations` ledger and reports.
 * `/readyz` turns that report into a 503, which is what holds traffic off a
 * half-migrated instance.
 *
 * ─── Failure direction ──────────────────────────────────────────────────────
 *
 * Any error - no ledger table, no database, a permissions problem - resolves to
 * `checked: false` and NO pending list, never to a false alarm. A monitoring
 * check that reports an outage because it could not read a bookkeeping table
 * is a check that gets muted, and a muted check is the same as no check.
 */

/** Cached because /readyz can be polled every few seconds and this is DDL-static. */
let cache = null;
const CACHE_TTL_MS = Number(process.env.MIGRATION_CHECK_CACHE_MS) || 60_000;

/**
 * @returns {Promise<{checked: boolean, pending: string[], applied: number, reason?: string}>}
 */
async function checkPendingMigrations({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.value;
  }

  let value;

  try {
    // Required lazily. runMigration.js reads the filesystem at import time and
    // is the module that OWNS the schedule; importing it at the top of a file
    // that /readyz depends on would put a directory read on the health path.
    const { allMigrationFiles } = require("./runMigration");
    const expected = allMigrationFiles();

    const { rows } = await db.query("SELECT filename FROM schema_migrations");
    const applied = new Set(rows.map((r) => r.filename));

    const pending = expected.filter((f) => !applied.has(f));

    value = { checked: true, pending, applied: applied.size };
  } catch (err) {
    // Includes the legitimate case of a database that predates the ledger
    // (SEC-21.1). "Cannot tell" is not "behind".
    value = {
      checked: false,
      pending: [],
      applied: 0,
      reason: (err && err.message) || "unknown",
    };
  }

  cache = { at: Date.now(), value };
  return value;
}

/** Test-only. */
function resetCache() {
  cache = null;
}

module.exports = { checkPendingMigrations, resetCache, CACHE_TTL_MS };
