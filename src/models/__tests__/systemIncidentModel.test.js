// System Health module: system_incidents is the persisted half of
// providerErrorLog.js's image-provider failures. Mirrors
// securityEventModel.test.js's structure and reasoning exactly.
//
// SYSTEM_INCIDENTS_PERSIST_IN_TEST=true is set BEFORE requiring the module:
// the model gates real writes off under NODE_ENV=test by default (see
// systemIncidentModel.js) - logProviderError runs unmocked from many
// generation-path tests, none of which expect a database call. This file is
// the deliberate, explicit exception.
process.env.SYSTEM_INCIDENTS_PERSIST_IN_TEST = "true";

jest.mock("../../config/db", () => ({ query: jest.fn() }));

const db = require("../../config/db");
const { record, list } = require("../systemIncidentModel");

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
  db.query.mockResolvedValue({ rows: [{ id: "incident-1" }] });
});

afterEach(() => {
  console.error.mockRestore();
});

describe("record", () => {
  it("maps an entry onto the system_incidents columns in order", async () => {
    await record({
      source: "image_provider",
      severity: "error",
      provider: "fal",
      phase: "provider",
      kind: "rate_limited",
      message: "upstream 429",
      statusCode: 429,
      requestId: "req-1",
      userId: "11111111-1111-1111-1111-111111111111",
      endpoint: "POST /api/generate",
      detail: { bodyKeys: ["detail"], errorName: "ApiError" },
    });

    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0];

    expect(sql).toContain("INSERT INTO system_incidents");
    expect(params).toEqual([
      "image_provider",
      "error",
      "fal",
      "provider",
      "rate_limited",
      "upstream 429",
      429,
      "req-1",
      "11111111-1111-1111-1111-111111111111",
      "POST /api/generate",
      JSON.stringify({ bodyKeys: ["detail"], errorName: "ApiError" }),
    ]);
  });

  it("defaults severity to 'error' and drops a non-UUID userId", async () => {
    await record({ source: "image_provider", userId: "not-a-uuid" });

    const [, params] = db.query.mock.calls[0];
    expect(params[1]).toBe("error");
    expect(params[8]).toBeNull();
  });

  it("never throws when the insert fails - callers do not await this", async () => {
    db.query.mockRejectedValueOnce(new Error("connection refused"));

    await expect(record({ source: "image_provider" })).resolves.toBeUndefined();
  });

  it("redacts credential-shaped keys in detail the same way admin_audit_log does", async () => {
    await record({ source: "image_provider", detail: { apiKey: "SENTINEL-KEY", errorName: "ApiError" } });

    const [, params] = db.query.mock.calls[0];
    expect(params[10]).not.toContain("SENTINEL-KEY");
  });
});

describe("list", () => {
  beforeEach(() => {
    db.query.mockResolvedValueOnce({ rows: [{ id: "incident-1" }] }).mockResolvedValueOnce({ rows: [{ total: 1 }] });
  });

  it("returns rows and total for an unfiltered page", async () => {
    const result = await list({ limit: 50, offset: 0 });

    expect(result).toEqual({ rows: [{ id: "incident-1" }], total: 1 });
    const [listSql, listParams] = db.query.mock.calls[0];
    expect(listSql).not.toContain("WHERE");
    expect(listParams).toEqual([50, 0]);
  });

  it("filters by source and severity, ignoring the 'all' sentinel", async () => {
    await list({ limit: 50, offset: 0, source: "all", severity: "all" });
    expect(db.query.mock.calls[0][0]).not.toContain("source =");
    expect(db.query.mock.calls[0][0]).not.toContain("severity =");

    jest.clearAllMocks();
    db.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ total: 0 }] });
    await list({ limit: 50, offset: 0, source: "image_provider", severity: "error" });
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain("source = $1");
    expect(sql).toContain("severity = $2");
    expect(params.slice(0, 2)).toEqual(["image_provider", "error"]);
  });

  it("uses the same WHERE clause for the count query as the list query", async () => {
    await list({ limit: 50, offset: 0, source: "image_provider", q: "timeout" });

    const [listSql, listParams] = db.query.mock.calls[0];
    const [countSql, countParams] = db.query.mock.calls[1];

    const listWhere = listSql.slice(listSql.indexOf("WHERE"), listSql.indexOf("ORDER BY"));
    const countWhere = countSql.slice(countSql.indexOf("WHERE"));
    expect(countWhere.trim()).toBe(listWhere.trim());
    expect(countParams).toEqual(listParams.slice(0, -2));
  });
});
