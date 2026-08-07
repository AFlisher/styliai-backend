const { Client } = require("pg");
const db = require("../config/db");

/**
 * System Health module — the queryable record of backupDatabase.js /
 * backupStorage.js's success (SEC-21.1/21.2/21.3's gap: those scripts write a
 * local manifest file and nothing else, so "did the last backup succeed" was
 * previously answerable only from local disk or an external cron's own logs).
 *
 * `record()` deliberately does NOT use the shared `db` pool that `latest()`/
 * `list()` below use. Those two run inside the long-lived API process, where
 * the shared pool is exactly right - the same as every other model. `record()`
 * only ever runs from backupDatabase.js/backupStorage.js, standalone CLI
 * scripts that must exit promptly once their work is done. Borrowing the
 * shared pool there would either leave an idle connection open (blocking the
 * CLI process from exiting until DB_POOL_IDLE_TIMEOUT_MS elapses) or, if
 * closed here, tear the pool down out from under a running API process that
 * happened to import this file. A short-lived `pg.Client` that connects,
 * writes one row, and disconnects - the same pattern runMigration.js already
 * uses for the same reason - has neither problem.
 */

const INSERT_SQL = `
  INSERT INTO backup_runs (kind, status, bytes, object_count, duration_ms, detail)
  VALUES ($1, $2, $3, $4, $5, $6)
  RETURNING id
`;

function intOrNull(value) {
  return Number.isFinite(value) ? Math.round(value) : null;
}

/**
 * Records one backup attempt. Callers wrap this in try/catch (see
 * backupDatabase.js/backupStorage.js): a failure to record must never be
 * mistaken for a failed backup, since by the time this runs the backup
 * itself has already completed and been written to disk.
 */
async function record({ kind, status, bytes, objectCount, durationMs, detail, connectionString = process.env.DATABASE_URL } = {}) {
  if (!connectionString) {
    throw new Error("No DATABASE_URL and no connection string supplied.");
  }

  const client = new Client({ connectionString, ssl: db.buildSslConfig(process.env) });
  await client.connect();
  try {
    await client.query(INSERT_SQL, [
      kind,
      status,
      intOrNull(bytes),
      intOrNull(objectCount),
      intOrNull(durationMs),
      detail ? JSON.stringify(detail) : null,
    ]);
  } finally {
    await client.end();
  }
}

const LIST_COLUMNS = `
  id, kind, status, bytes, object_count AS "objectCount",
  duration_ms AS "durationMs", detail, created_at AS "createdAt"
`;

/** The most recent SUCCESSFUL run of one kind - "last successful backup". */
async function latest({ kind } = {}) {
  const where = kind ? "WHERE kind = $1 AND status = 'success'" : "WHERE status = 'success'";
  const params = kind ? [kind] : [];

  const res = await db.query(
    `SELECT ${LIST_COLUMNS} FROM backup_runs ${where} ORDER BY created_at DESC LIMIT 1`,
    params
  );
  return res.rows[0] || null;
}

/** Recent runs of any status, for the Timeline view - a stalled/failed run is as newsworthy as a success. */
async function list({ limit, offset, kind } = {}) {
  const where = kind ? "WHERE kind = $1" : "";
  const params = kind ? [kind] : [];

  const rows = await db.query(
    `SELECT ${LIST_COLUMNS}
       FROM backup_runs
       ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );

  const countRes = await db.query(`SELECT COUNT(*)::int AS total FROM backup_runs ${where}`, params);

  return { rows: rows.rows, total: countRes.rows[0]?.total ?? 0 };
}

module.exports = { record, latest, list };
