const { buildPoolConfig } = require("../db");

/**
 * SEC-19.3. These bounds are asserted directly rather than inferred from
 * behaviour, because a missing statement_timeout is invisible until the
 * incident it causes - there is no failing request to notice, only a slow one
 * that never ends.
 */
describe("SEC-19.3 — pool bounds are explicit", () => {
  const base = { DATABASE_URL: "postgres://x/y" };

  it("sets every bound the audit named", () => {
    const cfg = buildPoolConfig(base);
    for (const key of [
      "max",
      "idleTimeoutMillis",
      "connectionTimeoutMillis",
      "statement_timeout",
      "query_timeout",
      "application_name",
    ]) {
      expect(cfg[key]).toBeDefined();
    }
  });

  // The consequential half. Without this, a lock wait or a missing-index
  // regression holds its connection until Postgres or the network gives up,
  // and ten of those is a total outage - including /healthz and login.
  it("sets a positive, finite statement_timeout", () => {
    const cfg = buildPoolConfig(base);
    expect(cfg.statement_timeout).toBeGreaterThan(0);
    expect(Number.isFinite(cfg.statement_timeout)).toBe(true);
  });

  it("keeps query_timeout above statement_timeout so the server-side cancel wins", () => {
    const cfg = buildPoolConfig(base);
    expect(cfg.query_timeout).toBeGreaterThan(cfg.statement_timeout);
  });

  it("names the application so a blocking session is attributable in pg_stat_activity", () => {
    expect(buildPoolConfig(base).application_name).toBe("styliai-backend");
  });

  it("honours valid overrides", () => {
    const cfg = buildPoolConfig({
      ...base,
      DB_POOL_MAX: "25",
      DB_STATEMENT_TIMEOUT_MS: "3000",
      DB_APPLICATION_NAME: "styliai-worker",
    });
    expect(cfg.max).toBe(25);
    expect(cfg.statement_timeout).toBe(3000);
    expect(cfg.application_name).toBe("styliai-worker");
  });

  // A typo must not disable a bound. Setting statement_timeout to 0 in
  // Postgres means NO timeout - the exact failure the setting exists to
  // prevent - so "0 is ignored" is a security property, not tidiness.
  it.each([["0"], ["-1"], ["abc"], ["NaN"], ["Infinity"], ["  "]])(
    "ignores the invalid override %s and keeps the safe default",
    (value) => {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      const cfg = buildPoolConfig({ ...base, DB_STATEMENT_TIMEOUT_MS: value });
      expect(cfg.statement_timeout).toBe(10_000);
      warn.mockRestore();
    }
  );

  it("warns when an override is ignored rather than failing silently", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    buildPoolConfig({ ...base, DB_POOL_MAX: "not-a-number" });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  // VACUITY: if buildPoolConfig ignored its env argument entirely, the
  // override test above would fail - but this states the negative outright.
  it("VACUITY: the config genuinely varies with the environment", () => {
    const a = buildPoolConfig({ ...base, DB_POOL_MAX: "5" });
    const b = buildPoolConfig({ ...base, DB_POOL_MAX: "50" });
    expect(a.max).not.toBe(b.max);
  });
});
