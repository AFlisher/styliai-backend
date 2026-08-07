// Operations Center controller: thin HTTP adapters over adminAuditModel.list,
// securityEventModel.list and a purchase/ad-reward union query. Role gating
// itself is covered by adminRoleMatrix.test.js, per this repo's convention
// (see adminController.userManagement.test.js) - these tests are about
// query-param parsing, validation and response shape.

jest.mock("../../config/db", () => ({ query: jest.fn(), pool: { connect: jest.fn() } }));
jest.mock("../../models/adminAuditModel", () => ({ list: jest.fn() }));
jest.mock("../../models/securityEventModel", () => ({ list: jest.fn() }));

const db = require("../../config/db");
const adminAuditModel = require("../../models/adminAuditModel");
const securityEventModel = require("../../models/securityEventModel");
const {
  listAuditLog,
  listSecurityEvents,
  listPurchaseVerifications,
} = require("../operationsController");

function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  console.error.mockRestore();
});

describe("listAuditLog", () => {
  it("defaults limit/offset and passes query filters through to the model", async () => {
    adminAuditModel.list.mockResolvedValue({ rows: [{ id: "a-1" }], total: 1 });
    const res = makeRes();

    await listAuditLog({ query: { action: "POST /api/admin/users/:id/suspend", q: "jane" } }, res);

    expect(adminAuditModel.list).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 50,
        offset: 0,
        action: "POST /api/admin/users/:id/suspend",
        q: "jane",
      })
    );
    expect(res.json).toHaveBeenCalledWith({ entries: [{ id: "a-1" }], total: 1, limit: 50, offset: 0 });
  });

  it("clamps an oversized limit to the endpoint's ceiling", async () => {
    adminAuditModel.list.mockResolvedValue({ rows: [], total: 0 });
    const res = makeRes();

    await listAuditLog({ query: { limit: "99999" } }, res);

    expect(adminAuditModel.list).toHaveBeenCalledWith(expect.objectContaining({ limit: 200 }));
  });

  it("answers 500 rather than crashing when the model rejects", async () => {
    adminAuditModel.list.mockRejectedValue(new Error("db down"));
    const res = makeRes();

    await listAuditLog({ query: {} }, res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe("listSecurityEvents", () => {
  it("rejects an unrecognized eventType with 400 before querying", async () => {
    const res = makeRes();

    await listSecurityEvents({ query: { eventType: "made_up" } }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(securityEventModel.list).not.toHaveBeenCalled();
  });

  it("accepts the 'all' sentinel and each real event type", async () => {
    securityEventModel.list.mockResolvedValue({ rows: [], total: 0 });
    for (const eventType of ["all", "auth_failure", "authz_failure"]) {
      const res = makeRes();
      await listSecurityEvents({ query: { eventType } }, res);
      expect(res.status).not.toHaveBeenCalledWith(400);
    }
  });

  it("shapes the response as {events, total, limit, offset}", async () => {
    securityEventModel.list.mockResolvedValue({ rows: [{ id: "e-1" }], total: 1 });
    const res = makeRes();

    await listSecurityEvents({ query: {} }, res);

    expect(res.json).toHaveBeenCalledWith({ events: [{ id: "e-1" }], total: 1, limit: 50, offset: 0 });
  });
});

describe("listPurchaseVerifications", () => {
  it("rejects an unrecognized source with 400 before querying", async () => {
    const res = makeRes();

    await listPurchaseVerifications({ query: { source: "bitcoin" } }, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("unions wallet purchases and ad-reward verifications, filtered by source", async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: "tx-1", source: "ad_reward" }] })
      .mockResolvedValueOnce({ rows: [{ total: 1 }] });
    const res = makeRes();

    await listPurchaseVerifications({ query: { source: "ad_reward" } }, res);

    const [listSql, listParams] = db.query.mock.calls[0];
    expect(listSql).toContain("wallet_transactions");
    expect(listSql).toContain("processed_ad_transactions");
    expect(listParams[0]).toBe("ad_reward");
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ entries: [{ id: "tx-1", source: "ad_reward" }], total: 1 })
    );
  });

  it("passes a null source filter through for 'all' rather than a literal string", async () => {
    db.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ total: 0 }] });
    const res = makeRes();

    await listPurchaseVerifications({ query: {} }, res);

    expect(db.query.mock.calls[0][1][0]).toBeNull();
  });

  it("includes the honesty note that no real IAP flow is wired up yet", async () => {
    db.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ total: 0 }] });
    const res = makeRes();

    await listPurchaseVerifications({ query: {} }, res);

    const payload = res.json.mock.calls[0][0];
    expect(payload.note).toMatch(/no in-app-purchase flow/i);
  });
});
