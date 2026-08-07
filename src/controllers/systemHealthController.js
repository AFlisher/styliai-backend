const db = require("../config/db");
const packageJson = require("../../package.json");
const metrics = require("../utils/metrics");
const storageUsageService = require("../services/storageUsageService");
const systemIncidentModel = require("../models/systemIncidentModel");
const backupRunModel = require("../models/backupRunModel");
const integrityLedgerSweeper = require("../services/integrityLedgerSweeper");
const abuseDetection = require("../services/abuse/abuseDetection");
const { policy: abusePolicy } = require("../config/abusePolicy");
const { config: integrityConfig } = require("../config/playIntegrityConfig");
const { buildEnvSummary } = require("../config/envSummary");
const { clampLimit } = require("../utils/pagination");

/**
 * System Health module — the last one, and the only one built entirely from
 * composition plus two small new tables (system_incidents, backup_runs; see
 * migration_system_health.sql). Every sub-check below either reuses an
 * existing service verbatim (storageUsageService, metrics.snapshot) or reads
 * a value that already existed but was never surfaced (pool.totalCount,
 * schema_migrations, the sweepers' in-memory lastSweepAt).
 *
 * DESIGN: EVERY SECTION DEGRADES INDEPENDENTLY. This endpoint exists to be
 * looked at when something is wrong, so it must not itself become a 500 when
 * the database it is reporting on is down - that is the one failure mode that
 * makes a health dashboard useless exactly when it is needed. Each check that
 * can fail is wrapped so a single dependency outage produces one `status:
 * "down"` section, not a failed response. Contrast with /readyz (healthController.js),
 * which is unauthenticated and answers a binary "can this process serve
 * traffic" for a load balancer - this is the rich, authenticated diagnostic
 * view for a human, and the two are not meant to be interchangeable.
 */

async function checkDatabase() {
  const startedAt = Date.now();
  try {
    await db.query("SELECT 1");
    const latencyMs = Date.now() - startedAt;
    return {
      status: latencyMs > 1000 ? "degraded" : "ok",
      latencyMs,
      pool: {
        total: db.pool.totalCount,
        idle: db.pool.idleCount,
        waiting: db.pool.waitingCount,
      },
    };
  } catch (err) {
    return { status: "down", latencyMs: Date.now() - startedAt, error: err.message, pool: null };
  }
}

async function checkStorage() {
  // storageUsageService.getStorageUsage() never throws (see there) - the
  // try/catch is defense in depth around that documented contract, not a
  // substitute for it.
  try {
    const usage = await storageUsageService.getStorageUsage();
    let status = "ok";
    if (usage.unavailable) status = "down";
    else if (usage.stale || usage.truncated) status = "degraded";
    return { status, ...usage };
  } catch (err) {
    return { status: "down", error: err.message };
  }
}

function checkEmail() {
  const key = process.env.RESEND_API_KEY;
  const configured = Boolean(key && !key.startsWith("YOUR_"));
  return {
    status: configured ? "ok" : "degraded",
    provider: "resend",
    configured,
    note: configured ? null : "RESEND_API_KEY is not set - emails are simulated (logged, not sent).",
  };
}

// A rough, honest heuristic - not a real SLO. More than this many
// image-provider incidents in the last 24h is worth a glance, not an alarm.
const IMAGE_PROVIDER_INCIDENT_DEGRADED_THRESHOLD = 10;

async function checkImageProvider() {
  const provider = process.env.IMAGE_PROVIDER || "unknown";
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { rows, total } = await systemIncidentModel.list({
      limit: 1,
      offset: 0,
      source: "image_provider",
      from: since,
    });
    return {
      status: total > IMAGE_PROVIDER_INCIDENT_DEGRADED_THRESHOLD ? "degraded" : "ok",
      provider,
      recentIncidentCount: total,
      lastIncidentAt: rows[0] ? rows[0].createdAt : null,
    };
  } catch (err) {
    return { status: "down", provider, error: err.message, recentIncidentCount: null, lastIncidentAt: null };
  }
}

/**
 * Honest by design, not a placeholder: this codebase has no job queue at
 * all (confirmed against package.json - no Bull/BullMQ/pg-boss/etc).
 * Generation requests are synchronous request/response. A card that faked a
 * "queue depth: 0" would misrepresent the architecture; this says so.
 */
function checkQueue() {
  return {
    available: false,
    status: "not_applicable",
    note: "No job queue exists in this codebase - generation requests are synchronous request/response, not queued.",
  };
}

function checkScheduledJobs() {
  return [
    {
      name: "abuse_detection_sweep",
      description: "SEC-18.1 abuse detectors + risk scoring, opportunistic on request traffic.",
      enabled: abusePolicy.sweepEnabled,
      intervalMs: abusePolicy.sweepIntervalMs,
      ...abuseDetection.getSweepStatus(),
    },
    {
      name: "integrity_ledger_sweep",
      description: "SEC-0.4 Play Integrity replay-ledger retention, opportunistic on request traffic.",
      enabled: integrityConfig.enforcement !== "off",
      intervalMs: integrityConfig.sweepIntervalMs,
      ...integrityLedgerSweeper.getStatus(),
    },
  ];
}

async function checkMigrations() {
  try {
    const res = await db.query(
      `SELECT filename, applied_at AS "appliedAt", last_run_at AS "lastRunAt",
              run_count AS "runCount", duration_ms AS "durationMs"
         FROM schema_migrations
        ORDER BY last_run_at DESC
        LIMIT 5`
    );
    return { last: res.rows[0] || null, recent: res.rows };
  } catch (err) {
    return { last: null, recent: [], error: err.message };
  }
}

async function checkBackups() {
  try {
    const [database, storage, recent] = await Promise.all([
      backupRunModel.latest({ kind: "database" }),
      backupRunModel.latest({ kind: "storage" }),
      backupRunModel.list({ limit: 10, offset: 0 }),
    ]);
    return { last: { database, storage }, recent: recent.rows };
  } catch (err) {
    return { last: { database: null, storage: null }, recent: [], error: err.message };
  }
}

function overallStatus(sections) {
  const statuses = sections.map((s) => s.status);
  if (statuses.includes("down")) return "down";
  if (statuses.includes("degraded")) return "degraded";
  return "ok";
}

/** GET /api/admin/system-health */
async function getSystemHealth(req, res) {
  try {
    const [database, storage, imageProvider, migrations, backups] = await Promise.all([
      checkDatabase(),
      checkStorage(),
      checkImageProvider(),
      checkMigrations(),
      checkBackups(),
    ]);
    const email = checkEmail();

    const backend = {
      status: "ok",
      uptimeSeconds: Math.round(process.uptime()),
      nodeVersion: process.version,
      nodeEnv: process.env.NODE_ENV || null,
      requests: metrics.snapshot().requests,
    };

    const version = {
      app: packageJson.version || null,
      // Set by Railway at build time; undefined locally and in any
      // environment that doesn't provide it - reported as null rather than
      // guessed.
      commit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
    };

    res.set("Cache-Control", "no-store");
    res.json({
      status: overallStatus([backend, database, storage, email, imageProvider]),
      generatedAt: new Date().toISOString(),
      backend,
      database,
      storage,
      email,
      imageProvider,
      queue: checkQueue(),
      scheduledJobs: checkScheduledJobs(),
      environment: buildEnvSummary(),
      version,
      lastMigration: migrations.last,
      recentMigrations: migrations.recent,
      migrationsError: migrations.error || null,
      lastBackup: backups.last,
      recentBackups: backups.recent,
      backupsError: backups.error || null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Internal server error." });
  }
}

const INCIDENT_SOURCES = new Set(["image_provider"]);
const INCIDENT_SEVERITIES = new Set(["warning", "error"]);

/** GET /api/admin/system-health/incidents?source=&severity=&q=&from=&to=&limit=&offset= */
async function listIncidents(req, res) {
  try {
    const query = req.query || {};
    const limit = clampLimit(query.limit, { def: 50, max: 200 });
    const offset = Math.max(0, Math.floor(Number(query.offset)) || 0);

    const source = typeof query.source === "string" ? query.source : "all";
    if (source !== "all" && !INCIDENT_SOURCES.has(source)) {
      return res.status(400).json({ message: "source must be one of: all, image_provider." });
    }
    const severity = typeof query.severity === "string" ? query.severity : "all";
    if (severity !== "all" && !INCIDENT_SEVERITIES.has(severity)) {
      return res.status(400).json({ message: "severity must be one of: all, warning, error." });
    }

    const { rows, total } = await systemIncidentModel.list({
      limit,
      offset,
      source,
      severity,
      q: typeof query.q === "string" ? query.q : undefined,
      from: typeof query.from === "string" ? query.from : undefined,
      to: typeof query.to === "string" ? query.to : undefined,
    });

    res.json({ incidents: rows, total, limit, offset });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Internal server error." });
  }
}

module.exports = { getSystemHealth, listIncidents };
