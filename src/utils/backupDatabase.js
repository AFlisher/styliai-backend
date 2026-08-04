const { spawn, execFile } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

/**
 * SEC-21.2 - an independent database backup, produced from this repository.
 *
 * WHY THIS EXISTS WHEN SUPABASE ALREADY BACKS UP. The audit's evidence is that
 * "database backups are entirely Supabase-managed" and that three things are
 * unconfirmed: whether daily backups are on, what the retention window is, and
 * whether PITR is available on this plan. Two of those are owner questions this
 * repository cannot answer. But all three share a single failure mode - the
 * backup you need is inside a system you may have lost access to, or that never
 * had the retention you assumed - and the answer to that is a copy you hold
 * yourself, with a retention you chose.
 *
 * This does not replace the platform backup. It is the second copy, and it is
 * the one whose existence can be verified from the repository.
 *
 * NEVER OVERWRITES. Output filenames carry a UTC timestamp and the script
 * refuses to write over an existing file. A backup tool that can clobber a
 * previous backup is a tool that can destroy the thing you are about to need,
 * and the moment that matters is the one where someone re-runs it in a panic.
 *
 * NEVER TOUCHES THE SOURCE. `pg_dump` is read-only; there is no path in this
 * file that writes to the database it is reading.
 */

const DEFAULT_DIR = process.env.BACKUP_DIR || path.join(process.cwd(), "backups");

/** UTC, sortable, filesystem-safe. Sorting by name is sorting by age. */
function timestamp(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, "-").replace("Z", "Z");
}

/**
 * Confirms `pg_dump` is actually available before promising a backup.
 *
 * The project's rule is never to assume infrastructure exists. `pg_dump` ships
 * with the Postgres client tools and is frequently absent on a machine that
 * only ever ran the app - so the failure mode without this check is a cryptic
 * ENOENT at the moment someone is trying to take an emergency backup.
 */
function checkPgDump() {
  return new Promise((resolve) => {
    execFile("pg_dump", ["--version"], (err, stdout) => {
      if (err) return resolve({ available: false, version: null });
      resolve({ available: true, version: String(stdout).trim() });
    });
  });
}

/**
 * Translates a `postgres://` URL into the environment variables libpq reads.
 *
 * Exported and pure so the translation can be tested without spawning
 * anything - and it is worth testing, because a silently wrong `sslmode` here
 * produces a backup script that works locally and fails against Supabase,
 * which requires TLS.
 */
function libpqEnvFrom(connectionString) {
  const u = new URL(connectionString);
  const env = {
    PGHOST: u.hostname,
    PGPORT: u.port || "5432",
    PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, "")) || "postgres",
    PGCONNECT_TIMEOUT: "15",
  };
  if (u.username) env.PGUSER = decodeURIComponent(u.username);
  if (u.password) env.PGPASSWORD = decodeURIComponent(u.password);

  // Honour an explicit sslmode from the URL; otherwise require TLS. Defaulting
  // to `require` rather than libpq's own `prefer` is deliberate: `prefer`
  // silently falls back to an unencrypted connection, and a backup is the
  // single largest bulk transfer of user data this system ever performs.
  const sslmode = u.searchParams.get("sslmode");
  env.PGSSLMODE = sslmode || "require";

  return env;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (d) => hash.update(d));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * Takes the dump.
 *
 * Custom format (`-Fc`) rather than plain SQL: it is compressed, and
 * `pg_restore` can restore it selectively - which matters during a real
 * incident where the goal is often one table rather than the whole database.
 */
async function backupDatabase({
  connectionString = process.env.DATABASE_URL,
  outputDir = DEFAULT_DIR,
  now = new Date(),
} = {}) {
  if (!connectionString) {
    throw new Error("No DATABASE_URL and no connection string supplied.");
  }

  const tool = await checkPgDump();
  if (!tool.available) {
    throw new Error(
      "pg_dump is not on PATH. Install the PostgreSQL client tools " +
        "(e.g. `winget install PostgreSQL.PostgreSQL` or `apt install postgresql-client`). " +
        "This script cannot back up without it."
    );
  }

  fs.mkdirSync(outputDir, { recursive: true });

  const base = `styliai-db-${timestamp(now)}`;
  const dumpPath = path.join(outputDir, `${base}.dump`);
  const manifestPath = path.join(outputDir, `${base}.manifest.json`);

  // The no-clobber guarantee, checked rather than assumed.
  for (const p of [dumpPath, manifestPath]) {
    if (fs.existsSync(p)) {
      throw new Error(`Refusing to overwrite an existing backup file: ${p}`);
    }
  }

  const startedAt = Date.now();

  await new Promise((resolve, reject) => {
    // The credentials go in the ENVIRONMENT, not in argv.
    //
    // Passing the whole connection URI to pg_dump as a positional argument is
    // the obvious form and is wrong on a shared host: process arguments are
    // world-readable (via /proc on Linux, WMI on Windows), so the database
    // password would be visible to every other user for the lifetime of the
    // dump. (The URI form is deliberately not written out here - a credential-
    // shaped string in a tracked file trips this project's own secret scanner,
    // and describing it beats quoting it.) libpq reads PGHOST /
    // PGPORT / PGUSER / PGPASSWORD / PGDATABASE / PGSSLMODE from the
    // environment instead, which is not.
    //
    // Note it does NOT read DATABASE_URL - that is an application convention,
    // not a libpq one - so the URL is parsed into the parts libpq understands.
    const child = spawn(
      "pg_dump",
      ["--format=custom", "--no-owner", "--no-privileges", "--file", dumpPath],
      { env: { ...process.env, ...libpqEnvFrom(connectionString) } }
    );

    let stderr = "";
    child.stderr.on("data", (d) => { stderr += String(d); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve();
      reject(new Error(`pg_dump exited ${code}: ${stderr.slice(0, 500)}`));
    });
  });

  const stats = fs.statSync(dumpPath);
  const checksum = await sha256File(dumpPath);

  // The manifest is what makes the backup VERIFIABLE rather than merely
  // present. Without a recorded checksum, a truncated or partially-written
  // dump is indistinguishable from a good one until the restore fails.
  const manifest = {
    kind: "styliai-database-backup",
    createdAt: new Date(now).toISOString(),
    file: path.basename(dumpPath),
    bytes: stats.size,
    sha256: checksum,
    pgDumpVersion: tool.version,
    durationMs: Date.now() - startedAt,
    // Recorded so a restore can be paired with the storage backup of the same
    // moment - the two are one recovery unit (SEC-21.3).
    pairWith: "run `npm run backup:storage` for the matching object backup",
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  return { dumpPath, manifestPath, manifest };
}

/** Re-hashes a dump against its manifest. Detects truncation and bit-rot. */
async function verifyBackup(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const dumpPath = path.join(path.dirname(manifestPath), manifest.file);

  if (!fs.existsSync(dumpPath)) {
    return { ok: false, reason: "dump_missing", dumpPath };
  }
  const stats = fs.statSync(dumpPath);
  if (stats.size !== manifest.bytes) {
    return { ok: false, reason: "size_mismatch", expected: manifest.bytes, actual: stats.size };
  }
  const checksum = await sha256File(dumpPath);
  if (checksum !== manifest.sha256) {
    return { ok: false, reason: "checksum_mismatch" };
  }
  return { ok: true, manifest };
}

if (require.main === module) {
  const arg = process.argv[2];
  const run = arg && arg.endsWith(".manifest.json")
    ? verifyBackup(arg).then((r) => {
        if (r.ok) {
          console.log(`✅ Backup verified — ${r.manifest.file} (${r.manifest.bytes} bytes)`);
        } else {
          console.error(`❌ Backup INVALID — ${r.reason}`);
          process.exitCode = 1;
        }
      })
    : backupDatabase().then(({ dumpPath, manifest }) => {
        console.log(`✅ Backup written — ${dumpPath}`);
        console.log(`   ${manifest.bytes} bytes · sha256 ${manifest.sha256.slice(0, 16)}… · ${manifest.durationMs} ms`);
        console.log(`   Verify later with: node src/utils/backupDatabase.js <manifest.json>`);
        console.log(`   ⚠️  Storage is a separate system — run \`npm run backup:storage\` for the matching object backup.`);
      });

  run.catch((err) => {
    console.error(`❌ ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { backupDatabase, verifyBackup, checkPgDump, timestamp, sha256File, libpqEnvFrom, DEFAULT_DIR };
