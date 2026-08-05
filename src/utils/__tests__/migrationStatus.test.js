"use strict";

/**
 * Sprint 3 / H-9 — the pending-migration gate.
 *
 * The property that matters most here is the failure DIRECTION. This feeds
 * /readyz, so a false "behind" takes the service out of rotation over a
 * bookkeeping table it merely could not read - and a readiness check that does
 * that gets muted, which is the same as not having one.
 */

jest.mock("../../config/db", () => ({ query: jest.fn(), pool: { connect: jest.fn() } }));

const db = require("../../config/db");
const { checkPendingMigrations, resetCache } = require("../migrationStatus");
const { allMigrationFiles } = require("../runMigration");

const EXPECTED = allMigrationFiles();

beforeEach(() => {
  jest.clearAllMocks();
  resetCache();
});

describe("a fully migrated database", () => {
  it("reports nothing pending", async () => {
    db.query.mockResolvedValue({
      rows: EXPECTED.map((filename) => ({ filename })),
    });

    const status = await checkPendingMigrations();

    expect(status.checked).toBe(true);
    expect(status.pending).toEqual([]);
    expect(status.applied).toBe(EXPECTED.length);
  });
});

describe("a database behind the code", () => {
  it("names exactly what is missing", async () => {
    const applied = EXPECTED.slice(0, EXPECTED.length - 2);
    db.query.mockResolvedValue({ rows: applied.map((filename) => ({ filename })) });

    const status = await checkPendingMigrations();

    expect(status.checked).toBe(true);
    expect(status.pending).toEqual(EXPECTED.slice(EXPECTED.length - 2));
  });

  it("treats a completely empty ledger as everything pending", async () => {
    db.query.mockResolvedValue({ rows: [] });

    const status = await checkPendingMigrations();

    expect(status.pending).toHaveLength(EXPECTED.length);
  });
});

describe("failure direction", () => {
  it("reports 'cannot tell' rather than 'behind' when the query fails", async () => {
    db.query.mockRejectedValue(new Error("relation schema_migrations does not exist"));

    const status = await checkPendingMigrations();

    // THE assertion in this file. `checked: false` with an empty pending list
    // is what stops /readyz 503-ing a healthy service because the ledger table
    // is missing - which is the legitimate state of any database predating
    // SEC-21.1.
    expect(status.checked).toBe(false);
    expect(status.pending).toEqual([]);
    expect(status.reason).toContain("schema_migrations");
  });

  it("never throws", async () => {
    db.query.mockRejectedValue(new Error("connection refused"));
    await expect(checkPendingMigrations()).resolves.toBeDefined();
  });
});

describe("caching", () => {
  it("does not re-query on every call", async () => {
    db.query.mockResolvedValue({ rows: [] });

    await checkPendingMigrations();
    await checkPendingMigrations();
    await checkPendingMigrations();

    // /readyz can be polled every few seconds; the schedule is DDL-static.
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it("re-queries when forced", async () => {
    db.query.mockResolvedValue({ rows: [] });

    await checkPendingMigrations();
    await checkPendingMigrations({ force: true });

    expect(db.query).toHaveBeenCalledTimes(2);
  });
});

describe("what it reads", () => {
  it("compares against the runner's own schedule, including the ledger migration", async () => {
    db.query.mockResolvedValue({ rows: [] });

    const status = await checkPendingMigrations();

    // allMigrationFiles() is [ledger, ...MIGRATIONS] - the ledger must be
    // included or a fresh database would look one migration closer to
    // complete than it is.
    expect(status.pending).toContain("migration_schema_migrations.sql");
    expect(status.pending).toContain("migration.sql");
  });

  it("only ever issues a SELECT", async () => {
    db.query.mockResolvedValue({ rows: [] });

    await checkPendingMigrations();

    const [sql] = db.query.mock.calls[0];
    expect(sql).toMatch(/^\s*SELECT/i);
    // This runs on boot and on every readiness probe. It must never be able to
    // alter the schema as a side effect of a restart.
    expect(sql).not.toMatch(/INSERT|UPDATE|DELETE|ALTER|CREATE|DROP/i);
  });
});
