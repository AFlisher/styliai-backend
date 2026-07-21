/**
 * Logout / refresh-token revocation suite (security fix M-1):
 * POST /api/auth/logout requires authentication and revokes the stored
 * refresh token hash so a copy an attacker may hold stops working.
 */

require("./setupEnv");

jest.mock("../../src/config/db", () => require("./fakeDb"));
jest.mock("../../src/config/supabase", () => ({ storage: { from: () => ({}) } }));

const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const request = require("supertest");
const app = require("../../src/app");
const fakeDb = require("./fakeDb");

const sha256 = (v) => crypto.createHash("sha256").update(v).digest("hex");
const userToken = (id) =>
  jwt.sign({ sub: id, email: `${id}@x.com`, role: "authenticated" }, process.env.SUPABASE_JWT_SECRET, { expiresIn: "1h" });

beforeEach(() => fakeDb.reset());

describe("POST /api/auth/logout", () => {
  it("requires authentication", async () => {
    const res = await request(app).post("/api/auth/logout");
    expect(res.status).toBe(401);
  });

  it("returns 204 and clears the caller's refresh_token_hash", async () => {
    const refreshToken = jwt.sign({ sub: "lo1" }, process.env.SUPABASE_JWT_SECRET, { expiresIn: "30d" });
    fakeDb.seedUser({ id: "lo1", email: "lo1@example.com", email_verified: true, refresh_token_hash: sha256(refreshToken) });

    const res = await request(app).post("/api/auth/logout").set("Authorization", `Bearer ${userToken("lo1")}`);

    expect(res.status).toBe(204);
    expect(res.body).toEqual({});
    const user = fakeDb.state.users.find((u) => u.id === "lo1");
    expect(user.refresh_token_hash).toBeNull();
  });

  it("revokes the refresh token so it can no longer be used to mint new access tokens", async () => {
    const refreshToken = jwt.sign({ sub: "lo2" }, process.env.SUPABASE_JWT_SECRET, { expiresIn: "30d" });
    fakeDb.seedUser({ id: "lo2", email: "lo2@example.com", email_verified: true, refresh_token_hash: sha256(refreshToken) });

    await request(app).post("/api/auth/logout").set("Authorization", `Bearer ${userToken("lo2")}`);

    const refresh = await request(app).post("/api/auth/refresh").send({ refreshToken });
    expect(refresh.status).toBe(401);
  });

  it("only revokes the caller's own token, not another user's", async () => {
    const otherRefresh = jwt.sign({ sub: "lo-other" }, process.env.SUPABASE_JWT_SECRET, { expiresIn: "30d" });
    fakeDb.seedUser({ id: "lo3", email: "lo3@example.com", email_verified: true, refresh_token_hash: sha256("self-token") });
    fakeDb.seedUser({ id: "lo-other", email: "other@example.com", email_verified: true, refresh_token_hash: sha256(otherRefresh) });

    await request(app).post("/api/auth/logout").set("Authorization", `Bearer ${userToken("lo3")}`);

    const other = fakeDb.state.users.find((u) => u.id === "lo-other");
    expect(other.refresh_token_hash).toBe(sha256(otherRefresh));
  });
});
