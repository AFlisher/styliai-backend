// User Management & Moderation module - covers the three new adminController
// endpoints (listUsers, getUserDetail, deleteUser) added alongside the Users
// page. suspend/reinstate/searchUserByEmail are pre-existing and covered by
// adminRoleMatrix.test.js at the authorization layer; this suite is about the
// business logic of the three new handlers, especially that deleteUser reuses
// the exact same setUserStatus transaction suspend/reinstate already use
// rather than a second, parallel implementation.

jest.mock("../../config/db", () => ({
  query: jest.fn(),
  pool: { connect: jest.fn() },
}));
jest.mock("../../services/sessionService", () => ({
  revokeAllUserRefreshTokens: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../services/wallet/walletService", () => ({
  getTransactionHistory: jest.fn(),
}));

const db = require("../../config/db");
const sessionService = require("../../services/sessionService");
const walletService = require("../../services/wallet/walletService");
const { listUsers, getUserDetail, deleteUser } = require("../adminController");

function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  console.error.mockRestore();
});

describe("listUsers", () => {
  it("returns users and a total count with default paging", async () => {
    const rows = [{ id: "u1", email: "a@example.com", fullName: "A", status: "active", riskScore: null }];
    db.query.mockResolvedValueOnce({ rows }).mockResolvedValueOnce({ rows: [{ total: 1 }] });

    const req = { query: {} };
    const res = makeRes();
    await listUsers(req, res);

    expect(res.json).toHaveBeenCalledWith({ users: rows, total: 1, limit: 25, offset: 0 });
    const [listSql, listParams] = db.query.mock.calls[0];
    expect(listSql).toContain("LEFT JOIN user_risk_scores");
    expect(listSql).toContain("ORDER BY u.created_at DESC");
    expect(listParams).toEqual([25, 0]);
  });

  it("filters by search term against email and full name, case-insensitively", async () => {
    db.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ total: 0 }] });

    const req = { query: { q: "Jane" } };
    const res = makeRes();
    await listUsers(req, res);

    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain("LOWER(u.email) LIKE $1");
    expect(sql).toContain("LOWER(u.full_name) LIKE $1");
    expect(params[0]).toBe("%jane%");
  });

  it("filters by status", async () => {
    db.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ total: 0 }] });

    const req = { query: { status: "suspended" } };
    const res = makeRes();
    await listUsers(req, res);

    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain("u.status = $1");
    expect(params).toContain("suspended");
  });

  it("rejects an unknown status without querying the database", async () => {
    const req = { query: { status: "not-a-real-status" } };
    const res = makeRes();
    await listUsers(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("sorts by risk when asked", async () => {
    db.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ total: 0 }] });

    const req = { query: { sort: "risk" } };
    const res = makeRes();
    await listUsers(req, res);

    const [sql] = db.query.mock.calls[0];
    expect(sql).toContain("COALESCE(r.score, 0) DESC");
  });

  it("clamps limit and floors a negative offset to zero", async () => {
    db.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ total: 0 }] });

    const req = { query: { limit: "9999", offset: "-5" } };
    const res = makeRes();
    await listUsers(req, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ limit: 100, offset: 0 }));
  });
});

describe("getUserDetail", () => {
  it("returns the user with a credits summary sliced to the 10 most recent transactions", async () => {
    const user = { id: "u1", email: "a@example.com", status: "active", balance: 42, riskScore: 7 };
    db.query.mockResolvedValueOnce({ rows: [user] });
    const history = Array.from({ length: 15 }, (_, i) => ({ id: `t${i}`, amount: 1 }));
    walletService.getTransactionHistory.mockResolvedValueOnce(history);

    const req = { params: { id: "u1" } };
    const res = makeRes();
    await getUserDetail(req, res);

    expect(walletService.getTransactionHistory).toHaveBeenCalledWith("u1");
    expect(res.json).toHaveBeenCalledWith({
      user,
      credits: { balance: 42, recentTransactions: history.slice(0, 10) },
    });
  });

  it("404s when no user matches the id", async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    const req = { params: { id: "missing" } };
    const res = makeRes();
    await getUserDetail(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(walletService.getTransactionHistory).not.toHaveBeenCalled();
  });
});

describe("deleteUser", () => {
  it("reuses the same status-flip transaction as suspend: sets status='deleted', bumps token_version, revokes sessions", async () => {
    const client = {
      query: jest.fn(),
      release: jest.fn(),
    };
    const userId = "11111111-1111-1111-1111-111111111111";
    client.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({
        rows: [{ id: userId, email: "a@example.com", status: "deleted", token_version: 3 }],
      }) // UPDATE ... RETURNING
      .mockResolvedValueOnce(undefined); // COMMIT
    db.pool.connect.mockResolvedValueOnce(client);

    const req = {
      params: { id: userId },
      body: { reason: "Requested by user via support." },
      admin: { id: "admin-1" },
    };
    const res = makeRes();
    await deleteUser(req, res);

    const updateCall = client.query.mock.calls.find(([sql]) => sql.includes("UPDATE public.users"));
    expect(updateCall[0]).toContain("token_version = token_version + 1");
    expect(updateCall[0]).toContain("refresh_token_hash = NULL");
    expect(updateCall[1]).toEqual(["deleted", "Requested by user via support.", "admin-1", userId]);

    expect(sessionService.revokeAllUserRefreshTokens).toHaveBeenCalledWith(userId, "admin_deleted", client);
    expect(client.query).toHaveBeenCalledWith("COMMIT");
    expect(res.json).toHaveBeenCalledWith({
      id: userId,
      email: "a@example.com",
      status: "deleted",
      tokenVersion: 3,
    });
  });

  it("404s and rolls back when the user id doesn't exist", async () => {
    const client = { query: jest.fn(), release: jest.fn() };
    client.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // UPDATE finds nothing
      .mockResolvedValueOnce(undefined); // ROLLBACK
    db.pool.connect.mockResolvedValueOnce(client);

    const req = {
      params: { id: "22222222-2222-2222-2222-222222222222" },
      body: {},
      admin: { id: "admin-1" },
    };
    const res = makeRes();
    await deleteUser(req, res);

    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(res.status).toHaveBeenCalledWith(404);
    expect(sessionService.revokeAllUserRefreshTokens).not.toHaveBeenCalled();
  });

  it("rejects an id that isn't UUID-shaped before ever opening a connection", async () => {
    const req = { params: { id: "not-a-uuid" }, body: {}, admin: { id: "admin-1" } };
    const res = makeRes();
    await deleteUser(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(db.pool.connect).not.toHaveBeenCalled();
  });
});
