const fs = require('fs');
const { Pool } = require('pg');
require('dotenv').config();

/**
 * Builds the pg SSL options. Exported for tests.
 *
 * DATABASE_CA_CERT may hold either the CA certificate PEM itself or a path
 * to a PEM file (e.g. the CA download from the Supabase dashboard). When
 * present, the server certificate is fully verified - this is the intended
 * production configuration (audit finding #1). Without it, production falls
 * back to encrypted-but-unverified TLS (previous behavior) and logs a
 * warning on boot so the gap can't go unnoticed.
 */
function buildSslConfig(env = process.env) {
  const caSetting = env.DATABASE_CA_CERT;

  if (caSetting && caSetting.trim()) {
    const ca = caSetting.includes('-----BEGIN')
      ? caSetting
      : fs.readFileSync(caSetting.trim(), 'utf8');
    return { ca, rejectUnauthorized: true };
  }

  if (env.NODE_ENV === 'production') {
    console.warn(
      '[db] WARNING: DATABASE_CA_CERT is not set - the Postgres TLS certificate is NOT being verified. ' +
      'Download your provider\'s CA certificate and set DATABASE_CA_CERT to enable full verification.'
    );
    return { rejectUnauthorized: false };
  }

  return false;
}

/**
 * SEC-19.3 - explicit pool bounds and query deadlines.
 *
 * The pool previously carried exactly two options (connectionString, ssl), so
 * pg's defaults applied: 10 connections and, more consequentially, NO time
 * limit on any statement. Every route shares this pool, which is what turns a
 * single pathological query into a whole-service outage rather than one slow
 * request - a lock wait, a missing-index regression, or an accidental cross
 * join holds its connection until Postgres or the network gives up, and ten of
 * those means /healthz and /api/auth/login stop answering too.
 *
 * Every value is env-overridable because the right numbers depend on the
 * instance size and on how many instances share the database, neither of which
 * is knowable from here. An unparseable or non-positive override is IGNORED
 * rather than clamped or fatal - the same convention rateLimiters.js already
 * uses, and for the same reason: a typo in an env var must not silently
 * produce a pool of 0 connections or a 0 ms statement timeout, both of which
 * would take the service down harder than the setting they were meant to
 * tune. The default is always a safe value, so falling back to it is the
 * correct failure mode.
 */
function poolSetting(name, fallback, env = process.env) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      JSON.stringify({
        event: "db_pool_override_ignored",
        variable: name,
        reason: "not_a_positive_number",
      })
    );
    return fallback;
  }
  return parsed;
}

/**
 * Builds the pool options. Exported for tests, which assert the bounds
 * directly rather than inferring them from behaviour - a missing
 * statement_timeout is invisible until the incident it causes.
 */
function buildPoolConfig(env = process.env) {
  return {
    connectionString: env.DATABASE_URL,
    ssl: buildSslConfig(env),

    // Kept at pg's own default. Raising it without knowing the Postgres-side
    // max_connections (and how many app instances share it) trades one
    // exhaustion point for another, further away and harder to diagnose.
    max: poolSetting('DB_POOL_MAX', 10, env),

    // Return idle connections rather than holding them across a quiet period.
    idleTimeoutMillis: poolSetting('DB_POOL_IDLE_TIMEOUT_MS', 30_000, env),

    // Fail fast when the pool is saturated instead of queueing invisibly. A
    // request that cannot get a connection in 5s is already a failed request
    // from the user's point of view; surfacing it as an error makes pool
    // exhaustion diagnosable instead of presenting as universal slowness.
    connectionTimeoutMillis: poolSetting('DB_POOL_CONNECTION_TIMEOUT_MS', 5_000, env),

    // The important half. Server-side ceiling: Postgres itself cancels the
    // statement and releases the connection, so this holds even if the Node
    // process is too busy to enforce a client-side timer. 10s is far above
    // every query this application issues today (all indexed, mostly
    // single-row - the slowest is the admin 7-day aggregate) and far below the
    // point where held connections become an outage.
    statement_timeout: poolSetting('DB_STATEMENT_TIMEOUT_MS', 10_000, env),

    // Client-side companion, deliberately slightly longer so the server-side
    // cancellation wins under normal conditions and produces a precise
    // Postgres error. This one only covers the case where the server never
    // answers at all (connection wedged, network black hole).
    query_timeout: poolSetting('DB_QUERY_TIMEOUT_MS', 15_000, env),

    // Shows up in pg_stat_activity, so a DBA looking at a slow or blocking
    // session can tell which process owns it.
    application_name: env.DB_APPLICATION_NAME || 'styliai-backend',
  };
}

const pool = new Pool(buildPoolConfig());

/**
 * SEC-19.3 - runs a callback with a statement_timeout other than the pool
 * default, scoped to one connection and one transaction.
 *
 * Admin analytics legitimately aggregate more rows than any OLTP path, and the
 * report is explicit that they need "a longer, explicitly-scoped value" rather
 * than a raised global default - raising the default would hand the longer
 * budget to every unauthenticated endpoint too, which is exactly backwards.
 *
 * SET LOCAL is used rather than SET, so the override cannot outlive the
 * transaction and leak onto the next borrower of this pooled connection. The
 * ROLLBACK in the finally block is what guarantees that even when the callback
 * throws; these are read-only aggregates, so rolling back discards nothing.
 */
async function withStatementTimeout(timeoutMs, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Parameterised, because timeoutMs reaching this line from a config value
    // is one refactor away from it reaching here from a request.
    await client.query('SELECT set_config($1, $2, true)', [
      'statement_timeout',
      String(Math.floor(timeoutMs)),
    ]);
    return await fn(client);
  } finally {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      /* the connection is being released regardless; a failed rollback here
         means it is already broken, and pg discards broken connections */
    }
    client.release();
  }
}

/**
 * SEC-19.3 - the admin-analytics budget, as one named thing.
 *
 * Aggregates behind the admin dashboard scan more rows than any user-facing
 * query and are allowed to take longer. This is a separate, explicitly larger
 * budget rather than a raised global default, so the longer allowance is
 * available only to the authenticated admin surface that needs it. It is still
 * a bound: an admin aggregate that runs away is contained too, just later.
 */
const ANALYTICS_STATEMENT_TIMEOUT_MS = poolSetting('DB_ANALYTICS_STATEMENT_TIMEOUT_MS', 30_000);

function analyticsQuery(text, params) {
  return withStatementTimeout(ANALYTICS_STATEMENT_TIMEOUT_MS, (client) =>
    client.query(text, params)
  );
}

module.exports = {
  query: (text, params) => pool.query(text, params),
  analyticsQuery,
  pool,
  buildSslConfig,
  buildPoolConfig,
  withStatementTimeout,
  ANALYTICS_STATEMENT_TIMEOUT_MS,
};
