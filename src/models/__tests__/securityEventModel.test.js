// Operations Center: security_events is the persisted half of
// securityEvents.js's auth_failure/authz_failure categories. This suite pins
// two things: the write path never throws and maps entries onto columns
// correctly, and the read path's filter/pagination shape.
//
// SECURITY_EVENTS_PERSIST_IN_TEST=true is set BEFORE requiring the module:
// the model gates real writes off under NODE_ENV=test by default (see there
// for why - every other test in the suite calls logAuthFailure/
// logAuthzFailure unmocked, and none of them expect a database call). This
// file is the deliberate, explicit exception.
process.env.SECURITY_EVENTS_PERSIST_IN_TEST = "true";

jest.mock("../../config/db", () => ({ query: jest.fn() }));

const db = require("../../config/db");
const { record, list } = require("../securityEventModel");

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
  db.query.mockResolvedValue({ rows: [{ id: "event-1" }] });
});

afterEach(() => {
  console.error.mockRestore();
});

describe("record", () => {
  it("maps an entry onto the security_events columns in order", async () => {
    await record({
      eventType: "auth_failure",
      reason: "wrong_password",
      subject: "11111111-1111-1111-1111-111111111111",
      method: "POST",
      endpoint: "/api/auth/login",
      ip: "203.0.113.7",
      userId: "11111111-1111-1111-1111-111111111111",
      adminId: undefined,
      requestId: "req-1",
      detail: { attempt: 3 },
    });

    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0];

    expect(sql).toContain("INSERT INTO security_events");
    expect(params).toEqual([
      "auth_failure",
      "wrong_password",
      "11111111-1111-1111-1111-111111111111",
      "POST",
      "/api/auth/login",
      "203.0.113.7",
      "11111111-1111-1111-1111-111111111111",
      null,
      "req-1",
      JSON.stringify({ attempt: 3 }),
    ]);
  });

  it("drops a non-UUID userId/adminId instead of writing garbage into a uuid column", async () => {
    await record({ eventType: "authz_failure", subject: "not-a-uuid", userId: "not-a-uuid", adminId: "also-not-a-uuid" });

    const [, params] = db.query.mock.calls[0];
    // subject is a free-text column, so it keeps the raw value; user_id/
    // admin_id would fail a real uuid column type check, so those are nulled.
    expect(params[2]).toBe("not-a-uuid");
    expect(params[6]).toBeNull();
    expect(params[7]).toBeNull();
  });

  it("never throws when the insert fails - callers do not await this", async () => {
    db.query.mockRejectedValueOnce(new Error("connection refused"));

    await expect(record({ eventType: "auth_failure", reason: "x" })).resolves.toBeUndefined();
  });

  it("redacts credential-shaped keys in detail the same way admin_audit_log does", async () => {
    await record({ eventType: "authz_failure", detail: { token: "SENTINEL-TOKEN", required: "superadmin" } });

    const [, params] = db.query.mock.calls[0];
    expect(params[9]).not.toContain("SENTINEL-TOKEN");
  });
});

describe("list", () => {
  beforeEach(() => {
    db.query.mockResolvedValueOnce({ rows: [{ id: "event-1" }] }).mockResolvedValueOnce({ rows: [{ total: 1 }] });
  });

  it("returns rows and total for an unfiltered page", async () => {
    const result = await list({ limit: 25, offset: 0 });

    expect(result).toEqual({ rows: [{ id: "event-1" }], total: 1 });
    expect(db.query).toHaveBeenCalledTimes(2);
    const [listSql, listParams] = db.query.mock.calls[0];
    expect(listSql).not.toContain("WHERE");
    expect(listParams).toEqual([25, 0]);
  });

  it("filters by eventType, ignoring the 'all' sentinel", async () => {
    await list({ limit: 25, offset: 0, eventType: "all" });
    expect(db.query.mock.calls[0][0]).not.toContain("event_type =");

    jest.clearAllMocks();
    db.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ total: 0 }] });
    await list({ limit: 25, offset: 0, eventType: "auth_failure" });
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain("event_type = $1");
    expect(params[0]).toBe("auth_failure");
  });

  it("uses the same WHERE clause for the count query as the list query", async () => {
    await list({ limit: 25, offset: 0, eventType: "authz_failure", q: "role" });

    const [listSql, listParams] = db.query.mock.calls[0];
    const [countSql, countParams] = db.query.mock.calls[1];

    const listWhere = listSql.slice(listSql.indexOf("WHERE"), listSql.indexOf("ORDER BY"));
    const countWhere = countSql.slice(countSql.indexOf("WHERE"));
    expect(countWhere.trim()).toBe(listWhere.trim());
    // The count query has no LIMIT/OFFSET params, so it's the list params minus the trailing two.
    expect(countParams).toEqual(listParams.slice(0, -2));
  });
});
