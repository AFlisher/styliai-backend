/**
 * High-priority wallet + token-security suite (QA_TEST_PLAN.md):
 *   FT-020, API-017, SEC-011, SEC-012
 */

require("../critical/setupEnv");

jest.mock("../../src/config/db", () => require("../critical/fakeDb"));
jest.mock("../../src/config/supabase", () => ({ storage: { from: () => ({}) } }));

const jwt = require("jsonwebtoken");
const request = require("supertest");
const app = require("../../src/app");
const fakeDb = require("../critical/fakeDb");

const userToken = (id) =>
  jwt.sign({ sub: id, email: `${id}@x.com`, role: "authenticated" }, process.env.SUPABASE_JWT_SECRET, { expiresIn: "1h" });

beforeEach(() => fakeDb.reset());

describe("FT-020 — rewarded-ad credit (2 ads = 1 credit, capped 1/day)", () => {
  it("grants a credit only on the 2nd ad and enforces the daily cap on the 3rd", async () => {
    fakeDb.seedUser({ id: "w1", balance: 0, ads_progress: 0, email_verified: true });
    const call = () => request(app).post("/api/wallet/reward").set("Authorization", `Bearer ${userToken("w1")}`);

    const first = await call();
    expect(first.status).toBe(200);
    expect(first.body.rewarded).toBe(false);
    expect(first.body.adsProgress).toBe(1);

    const second = await call();
    expect(second.body.rewarded).toBe(true);
    expect(fakeDb.state.users.find((u) => u.id === "w1").balance).toBe(1);

    const third = await call();
    expect(third.body.dailyLimitReached).toBe(true);
    expect(fakeDb.state.users.find((u) => u.id === "w1").balance).toBe(1); // no extra credit
  });
});

describe("API-017 — GET /api/wallet returns the caller's wallet state", () => {
  it("returns balance, ads progress, generated images and daily-limit flag", async () => {
    fakeDb.seedUser({ id: "w2", balance: 7, ads_progress: 1, generated_images: 3, email_verified: true });
    const res = await request(app).get("/api/wallet").set("Authorization", `Bearer ${userToken("w2")}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ balance: 7, adsProgress: 1, generatedImages: 3, dailyLimitReached: false });
  });

  it("requires authentication", async () => {
    const res = await request(app).get("/api/wallet");
    expect(res.status).toBe(401);
  });
});

describe("SEC-011 — JWT tampering is rejected on protected routes", () => {
  const seed = () => fakeDb.seedUser({ id: "jt", balance: 1, email_verified: true });

  it("rejects an expired token", async () => {
    seed();
    const expired = jwt.sign({ sub: "jt", role: "authenticated" }, process.env.SUPABASE_JWT_SECRET, { expiresIn: -10 });
    const res = await request(app).get("/api/wallet").set("Authorization", `Bearer ${expired}`);
    expect(res.status).toBe(401);
  });

  it("rejects a token signed with the wrong secret", async () => {
    seed();
    const forged = jwt.sign({ sub: "jt", role: "authenticated" }, "attacker-secret", { expiresIn: "1h" });
    const res = await request(app).get("/api/wallet").set("Authorization", `Bearer ${forged}`);
    expect(res.status).toBe(401);
  });

  it("rejects an alg=none token", async () => {
    seed();
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: "jt", role: "authenticated" })).toString("base64url");
    const noneToken = `${header}.${payload}.`;
    const res = await request(app).get("/api/wallet").set("Authorization", `Bearer ${noneToken}`);
    expect(res.status).toBe(401);
  });

  it("rejects a token with a tampered payload (broken signature)", async () => {
    seed();
    const valid = userToken("jt");
    const [h, , s] = valid.split(".");
    const tampered = Buffer.from(JSON.stringify({ sub: "someone-else", role: "authenticated" })).toString("base64url");
    const res = await request(app).get("/api/wallet").set("Authorization", `Bearer ${h}.${tampered}.${s}`);
    expect(res.status).toBe(401);
  });
});

describe("SEC-012 — wallet data is scoped to the authenticated user (no IDOR)", () => {
  it("returns each caller only their own balance", async () => {
    fakeDb.seedUser({ id: "userA", balance: 5, email_verified: true });
    fakeDb.seedUser({ id: "userB", balance: 999, email_verified: true });

    const a = await request(app).get("/api/wallet").set("Authorization", `Bearer ${userToken("userA")}`);
    const b = await request(app).get("/api/wallet").set("Authorization", `Bearer ${userToken("userB")}`);

    expect(a.body.balance).toBe(5);
    expect(b.body.balance).toBe(999);
    // There is no request parameter that lets A address B's wallet - identity
    // comes solely from the verified token subject.
  });
});
