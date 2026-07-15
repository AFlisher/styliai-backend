/**
 * Medium/Low-priority admin-stats suite (QA_TEST_PLAN.md):
 *   FT-024, IT-008
 *
 * adminStatsController issues a fixed sequence of aggregate queries and a
 * Supabase storage listing; both are stubbed so the test targets the route
 * wiring, admin guard, and response contract.
 */

require("../critical/setupEnv");

jest.mock("../../src/config/db", () => ({ query: jest.fn(), pool: { connect: jest.fn() }, buildSslConfig: () => false }));
jest.mock("../../src/config/supabase", () => ({
  storage: { from: () => ({ list: jest.fn().mockResolvedValue({ data: [], error: null }) }) },
}));

const jwt = require("jsonwebtoken");
const request = require("supertest");
const app = require("../../src/app");
const db = require("../../src/config/db");

const adminToken = () => jwt.sign({ sub: "admin-1", email: "a@x.com", role: "admin" }, process.env.ADMIN_JWT_SECRET, { expiresIn: "2h" });

beforeEach(() => jest.clearAllMocks());

describe("FT-024 / IT-008 — admin analytics", () => {
  it("returns the analytics payload for an authorized admin", async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ count: 42 }] })   // total users
      .mockResolvedValueOnce({ rows: [{ count: 7 }] })    // active today
      .mockResolvedValueOnce({ rows: [{ count: 120 }] })  // images generated
      .mockResolvedValueOnce({ rows: [{ total: 240 }] })  // credits used
      .mockResolvedValueOnce({ rows: [{ label: "Mon", value: 3 }] }) // chart
      .mockResolvedValueOnce({ rows: [{ id: "t1", userEmail: "u@x.com", type: "generation", amount: -2, date: "2026-07-10" }] }); // recent

    const res = await request(app).get("/api/admin/stats").set("Authorization", `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      totalUsers: 42,
      activeToday: 7,
      imagesGenerated: 120,
      creditsUsed: 240,
      storageUsedMB: 0,
    });
    expect(Array.isArray(res.body.chartData)).toBe(true);
    expect(Array.isArray(res.body.recentActivity)).toBe(true);
  });

  it("is rejected without an admin token", async () => {
    const res = await request(app).get("/api/admin/stats");
    expect([401, 403]).toContain(res.status);
    expect(db.query).not.toHaveBeenCalled();
  });
});
