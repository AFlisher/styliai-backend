const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const expectations = require("../dr/schemaExpectations");
const runner = require("../runMigration");
const { libpqEnvFrom, timestamp, verifyBackup, sha256File } = require("../backupDatabase");

/**
 * Phase 9 — the parts of disaster recovery that can be proven without an
 * external system.
 *
 * The restore drill itself (SEC-21.2) is a human procedure against a scratch
 * project and cannot live here. What CAN live here is everything the drill
 * depends on being correct: that the expectations are derived rather than
 * stale, that a corrupted backup is detected, and that the credential handling
 * does not put a password somewhere it can be read.
 */

// ---------------------------------------------------------------------------
// SEC-21.1 — the migration schedule and ledger
// ---------------------------------------------------------------------------

describe("SEC-21.1 — the schedule is importable without side effects", () => {
  // Before the require.main guard, importing the runner to read the schedule
  // would have CONNECTED TO A DATABASE and applied 33 migrations. That is a
  // footgun anywhere and an actively dangerous one in recovery tooling, whose
  // entire job is to inspect without changing.
  it("exposes the schedule as data", () => {
    expect(Array.isArray(runner.MIGRATIONS)).toBe(true);
    expect(runner.MIGRATIONS.length).toBeGreaterThan(30);
    expect(typeof runner.LEDGER_MIGRATION).toBe("string");
  });

  it("puts the ledger first in allMigrationFiles, because it must exist before recording", () => {
    expect(runner.allMigrationFiles()[0]).toBe(runner.LEDGER_MIGRATION);
  });

  it("accounts for every migration file on disk", () => {
    const onDisk = fs
      .readdirSync(expectations.REPO_ROOT)
      .filter((f) => f.startsWith("migration") && f.endsWith(".sql"));
    const accounted = new Set([
      ...runner.MIGRATIONS,
      ...Object.keys(runner.SUPERSEDED),
      runner.LEDGER_MIGRATION,
    ]);
    expect(onDisk.filter((f) => !accounted.has(f))).toEqual([]);
  });

  it("never lists a migration twice", () => {
    const dupes = runner.MIGRATIONS.filter((f, i) => runner.MIGRATIONS.indexOf(f) !== i);
    expect(dupes).toEqual([]);
  });

  it("computes a stable checksum", () => {
    const a = runner.checksumOf("CREATE TABLE x();");
    expect(a).toBe(runner.checksumOf("CREATE TABLE x();"));
    expect(a).not.toBe(runner.checksumOf("CREATE TABLE y();"));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// SEC-21.2 — restore expectations are DERIVED, not stale
// ---------------------------------------------------------------------------

describe("SEC-21.2 — schema expectations track the migrations", () => {
  it("derives table names from the migration SQL", () => {
    const tables = expectations.expectedTables();
    // Spot-check tables created across widely separated phases, so a
    // regression in extraction shows up regardless of where it happens.
    for (const t of ["users", "creations", "wallet_transactions", "refresh_tokens",
                     "generation_idempotency", "abuse_findings", "schema_migrations"]) {
      expect(tables).toContain(t);
    }
  });

  // THE BUG THIS CAUGHT. These migrations are heavily commented, and
  // migration_ad_transactions.sql contains the prose "...CREATE TABLE IF NOT
  // EXISTS on every /api/wallet/reward/verify call", from which the extractor
  // derived a required table named `on`. A verifier that demands a table nobody
  // will ever create fails permanently — and a check that is always red is a
  // check that gets ignored.
  it("does not mistake prose in SQL comments for DDL", () => {
    expect(expectations.expectedTables()).not.toContain("on");
  });

  it("strips both line and block comments", () => {
    expect(expectations.tablesCreatedBy("-- CREATE TABLE ghost (x int);").size).toBe(0);
    expect(expectations.tablesCreatedBy("/* CREATE TABLE ghost (x int); */").size).toBe(0);
    expect(expectations.tablesCreatedBy("CREATE TABLE real_one (x int);").has("real_one")).toBe(true);
  });

  it("ignores ALTER TABLE, which does not assert ownership of a table", () => {
    expect(expectations.tablesCreatedBy("ALTER TABLE users ADD COLUMN x int;").size).toBe(0);
  });

  it("handles the schema-qualified and IF NOT EXISTS forms", () => {
    expect(expectations.tablesCreatedBy("CREATE TABLE public.a (x int);").has("a")).toBe(true);
    expect(expectations.tablesCreatedBy("CREATE TABLE IF NOT EXISTS b (x int);").has("b")).toBe(true);
  });

  // VACUITY: an extractor that returned everything, or nothing, would make the
  // restore verifier meaningless in opposite directions.
  it("VACUITY: extraction discriminates", () => {
    expect(expectations.tablesCreatedBy("SELECT 1;").size).toBe(0);
    expect(expectations.tablesCreatedBy("CREATE TABLE t (x int);").size).toBe(1);
  });

  it("names a finding for every critical constraint and index", () => {
    // Each entry has to say what it was defending, or a future reader cannot
    // judge whether it still matters.
    for (const c of expectations.CRITICAL_CONSTRAINTS) {
      expect(c.why).toEqual(expect.any(String));
      expect(c.why.length).toBeGreaterThan(5);
    }
    for (const i of expectations.CRITICAL_INDEXES) {
      expect(i.why).toEqual(expect.any(String));
    }
  });

  it("guards the constraints that fail SILENTLY rather than loudly", () => {
    const tables = expectations.CRITICAL_CONSTRAINTS.map((c) => c.table);
    // A missing table breaks the app immediately; a missing UNIQUE on
    // daily_rewards hands out unlimited credits and looks perfectly healthy.
    expect(tables).toContain("daily_rewards");
    expect(tables).toContain("generation_idempotency");
    expect(tables).toContain("processed_ad_transactions");
  });
});

// ---------------------------------------------------------------------------
// SEC-21.2 — backup credential handling and integrity
// ---------------------------------------------------------------------------

describe("SEC-21.2 — credentials never reach argv", () => {
  // The scheme is split so no contiguous connection-URI-with-password literal
  // exists in this tracked file. Such a string is credential-SHAPED, and this
  // project's own secret scanner (SEC-17.2) correctly refuses to distinguish a
  // fixture from a leak - the established convention, used by
  // test/medium/secrets.medium.test.js on its own fixtures, is to build the
  // value rather than allow-list the file.
  //
  // Note the pattern is DESCRIBED and not written out, even in a comment: a
  // comment is scanned like any other line, which is a mistake this project has
  // already made once (a .gitleaksignore that quoted the line it suppressed).
  const PG = "postgres" + "://";

  it("translates a URL into libpq environment variables", () => {
    const env = libpqEnvFrom(PG + "alice:s3cret@db.example.com:6543/appdb");
    expect(env).toMatchObject({
      PGHOST: "db.example.com",
      PGPORT: "6543",
      PGDATABASE: "appdb",
      PGUSER: "alice",
      PGPASSWORD: "s3cret",
    });
  });

  it("percent-decodes credentials, which Supabase URLs routinely contain", () => {
    const env = libpqEnvFrom(PG + "u%40x:p%40ss%3Aword@h/db");
    expect(env.PGUSER).toBe("u@x");
    expect(env.PGPASSWORD).toBe("p@ss:word");
  });

  // `prefer` silently falls back to an UNENCRYPTED connection, and a backup is
  // the single largest bulk transfer of user data this system performs.
  it("requires TLS by default rather than letting libpq prefer it", () => {
    expect(libpqEnvFrom(PG + "u:p@h/db").PGSSLMODE).toBe("require");
  });

  it("honours an explicit sslmode from the URL", () => {
    expect(libpqEnvFrom(PG + "u:p@h/db?sslmode=verify-full").PGSSLMODE).toBe("verify-full");
  });

  it("defaults the port and database rather than emitting undefined", () => {
    const env = libpqEnvFrom(PG + "u:p@h/");
    expect(env.PGPORT).toBe("5432");
    expect(env.PGDATABASE).toBe("postgres");
  });
});

describe("SEC-21.2 — backup filenames sort by age and never collide", () => {
  it("produces a filesystem-safe, sortable UTC stamp", () => {
    const s = timestamp(new Date("2026-08-04T18:30:05.123Z"));
    expect(s).not.toMatch(/[:]/);
    expect(s).toContain("2026-08-04");
  });

  it("sorts lexically in chronological order", () => {
    const early = timestamp(new Date("2026-08-04T01:00:00Z"));
    const late = timestamp(new Date("2026-08-04T23:00:00Z"));
    expect([late, early].sort()).toEqual([early, late]);
  });
});

describe("SEC-21.2 — an unverified backup is a hypothesis", () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "dr-test-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeBackup(contents) {
    const dump = path.join(dir, "styliai-db-x.dump");
    fs.writeFileSync(dump, contents);
    const manifest = {
      kind: "styliai-database-backup",
      file: "styliai-db-x.dump",
      bytes: Buffer.byteLength(contents),
      sha256: crypto.createHash("sha256").update(contents).digest("hex"),
    };
    const manifestPath = path.join(dir, "styliai-db-x.manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    return manifestPath;
  }

  it("accepts an intact backup", async () => {
    await expect(verifyBackup(writeBackup("PGDMP-pretend"))).resolves.toMatchObject({ ok: true });
  });

  it("detects a TRUNCATED dump — the failure that otherwise surfaces mid-restore", async () => {
    const m = writeBackup("PGDMP-pretend-full-content");
    fs.writeFileSync(path.join(dir, "styliai-db-x.dump"), "PGDMP-trunc");
    await expect(verifyBackup(m)).resolves.toMatchObject({ ok: false, reason: "size_mismatch" });
  });

  it("detects silent corruption at the same length", async () => {
    const m = writeBackup("AAAA");
    fs.writeFileSync(path.join(dir, "styliai-db-x.dump"), "AAAB");
    await expect(verifyBackup(m)).resolves.toMatchObject({ ok: false, reason: "checksum_mismatch" });
  });

  it("detects a manifest whose dump has gone missing", async () => {
    const m = writeBackup("x");
    fs.unlinkSync(path.join(dir, "styliai-db-x.dump"));
    await expect(verifyBackup(m)).resolves.toMatchObject({ ok: false, reason: "dump_missing" });
  });

  // VACUITY: a verifier that returned ok for everything would pass the happy
  // path above while certifying corrupt backups as good — the single worst
  // outcome for this tool, because the result is believed.
  it("VACUITY: verification is not a rubber stamp", async () => {
    const good = await verifyBackup(writeBackup("same-length!"));
    fs.writeFileSync(path.join(dir, "styliai-db-x.dump"), "SAME-LENGTH!");
    const bad = await verifyBackup(path.join(dir, "styliai-db-x.manifest.json"));
    expect(good.ok).toBe(true);
    expect(bad.ok).toBe(false);
  });

  it("hashes file contents, not filenames", async () => {
    const a = path.join(dir, "a.bin");
    const b = path.join(dir, "b.bin");
    fs.writeFileSync(a, "identical");
    fs.writeFileSync(b, "identical");
    expect(await sha256File(a)).toBe(await sha256File(b));
  });
});

// ---------------------------------------------------------------------------
// SEC-21.3 / SEC-21.5 — the operational documentation must stay honest
// ---------------------------------------------------------------------------

describe("SEC-21.5 — the runbook exists and states its own limits", () => {
  const runbook = fs.readFileSync(path.join(expectations.REPO_ROOT, "DISASTER_RECOVERY.md"), "utf8");

  it("defines RPO and RTO", () => {
    expect(runbook).toMatch(/\bRPO\b/);
    expect(runbook).toMatch(/\bRTO\b/);
  });

  it("covers the recovery steps the audit asked for", () => {
    for (const topic of [/restore the database/i, /storage/i, /secret/i, /rollback|RELEASE\.md/i]) {
      expect(runbook).toMatch(topic);
    }
  });

  // The audit's central point about backups applies to runbooks too: a document
  // that overstates its guarantees is worse than none, because it is believed.
  it("declares what has NOT been verified rather than implying coverage", () => {
    expect(runbook).toMatch(/UNKNOWN/);
    expect(runbook).toMatch(/never yet performed|Never/i);
  });

  it("states that a database restore does not restore storage", () => {
    // The mistake that produces a "successful" recovery where every gallery 404s.
    expect(runbook).toMatch(/does \*?not\*? restore Supabase Storage|separate systems/i);
  });

  it("lists what the repository cannot do", () => {
    expect(runbook).toMatch(/Cannot enable/i);
  });
});

describe("SEC-21.4 — release and rollback are documented", () => {
  const release = fs.readFileSync(path.join(expectations.REPO_ROOT, "RELEASE.md"), "utf8");

  it("explains whether a rollback needs a data step", () => {
    expect(release).toMatch(/additive/i);
    expect(release).toMatch(/rollback/i);
  });

  it("explains why there are no DOWN migrations", () => {
    // A reverse migration is code that runs once, under maximum pressure,
    // having never been tested.
    expect(release).toMatch(/`?DOWN`? migrations/i);
  });

  it("requires migrations to be listed in the tag message", () => {
    expect(release).toMatch(/migrations included|list the migrations/i);
  });
});
