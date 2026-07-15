/**
 * Medium-priority wallet/admin suite (QA_TEST_PLAN.md):
 *   FT-021, FT-023
 */

require("../critical/setupEnv");

jest.mock("../../src/config/db", () => require("../critical/fakeDb"));
jest.mock("../../src/config/supabase", () => ({ storage: { from: () => ({}) } }));

const jwt = require("jsonwebtoken");
const request = require("supertest");
const app = require("../../src/app");
const fakeDb = require("../critical/fakeDb");

const userToken = (id) => jwt.sign({ sub: id, email: `${id}@x.com`, role: "authenticated" }, process.env.SUPABASE_JWT_SECRET, { expiresIn: "1h" });
const adminToken = () => jwt.sign({ sub: "admin-1", email: "a@x.com", role: "admin" }, process.env.ADMIN_JWT_SECRET, { expiresIn: "2h" });

beforeEach(() => fakeDb.reset());

describe("FT-021 — GET /api/wallet/history returns the ledger newest-first", () => {
  it("returns the caller's transactions ordered by date desc with correct signs", async () => {
    fakeDb.seedUser({ id: "h1", balance: 5, email_verified: true });
    fakeDb.seedWalletTx("h1", { amount: 5, type: "purchase", createdAt: "2026-07-01T10:00:00Z" });
    fakeDb.seedWalletTx("h1", { amount: -2, type: "generation", createdAt: "2026-07-03T10:00:00Z" });
    fakeDb.seedWalletTx("h1", { amount: 1, type: "reward", createdAt: "2026-07-02T10:00:00Z" });
    // Another user's transaction must never appear.
    fakeDb.seedWalletTx("other", { amount: 99, type: "purchase", createdAt: "2026-07-05T10:00:00Z" });

    const res = await request(app).get("/api/wallet/history").set("Authorization", `Bearer ${userToken("h1")}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
    expect(res.body.map((t) => t.type)).toEqual(["generation", "reward", "purchase"]); // newest first
    expect(res.body.find((t) => t.type === "generation").amount).toBe(-2); // debit is negative
    expect(res.body.every((t) => t.userId === "h1")).toBe(true);
  });

  it("requires authentication", async () => {
    const res = await request(app).get("/api/wallet/history");
    expect(res.status).toBe(401);
  });
});

describe("FT-023 — admin balance adjustment", () => {
  it("credits a user and records an admin-type ledger entry", async () => {
    fakeDb.seedUser({ id: "u-adj", email: "adj@x.com", balance: 10 });
    const res = await request(app)
      .post("/api/admin/users/u-adj/adjust-balance")
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({ amount: 5, description: "goodwill credit" });

    expect(res.status).toBe(200);
    expect(res.body.balance).toBe(15);
    const entry = fakeDb.state.walletTransactions.find((t) => t.userId === "u-adj" && t.type === "admin");
    expect(entry).toBeDefined();
    expect(entry.amount).toBe(5);
  });

  it("debits a user (negative amount) and blocks over-drawing", async () => {
    fakeDb.seedUser({ id: "u-adj2", email: "adj2@x.com", balance: 3 });
    const ok = await request(app)
      .post("/api/admin/users/u-adj2/adjust-balance")
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({ amount: -2, description: "correction" });
    expect(ok.status).toBe(200);
    expect(ok.body.balance).toBe(1);

    const over = await request(app)
      .post("/api/admin/users/u-adj2/adjust-balance")
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({ amount: -50, description: "too much" });
    expect(over.status).toBe(400);
  });

  it("rejects zero/non-integer amounts and missing reason", async () => {
    fakeDb.seedUser({ id: "u-adj3", email: "adj3@x.com", balance: 10 });
    const zero = await request(app).post("/api/admin/users/u-adj3/adjust-balance").set("Authorization", `Bearer ${adminToken()}`).send({ amount: 0, description: "x" });
    const noReason = await request(app).post("/api/admin/users/u-adj3/adjust-balance").set("Authorization", `Bearer ${adminToken()}`).send({ amount: 5, description: "  " });
    expect(zero.status).toBe(400);
    expect(noReason.status).toBe(400);
  });

  it("requires an admin token", async () => {
    const res = await request(app).post("/api/admin/users/u-adj/adjust-balance").send({ amount: 5, description: "x" });
    expect([401, 403]).toContain(res.status);
  });
});
