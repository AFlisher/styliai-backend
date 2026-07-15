/**
 * Medium-priority creations suite (QA_TEST_PLAN.md):
 *   FT-019, IT-011
 */

require("../critical/setupEnv");

jest.mock("../../src/config/db", () => require("../critical/fakeDb"));
jest.mock("../../src/config/supabase", () => ({ storage: { from: () => ({}) } }));
jest.mock("../../src/models/creationsModel", () => ({
  getCreationsByUser: jest.fn(),
  addCreation: jest.fn(),
  deleteCreation: jest.fn(),
}));

const jwt = require("jsonwebtoken");
const request = require("supertest");
const app = require("../../src/app");
const creationsModel = require("../../src/models/creationsModel");

const token = (id) => jwt.sign({ sub: id, email: `${id}@x.com`, role: "authenticated" }, process.env.SUPABASE_JWT_SECRET, { expiresIn: "1h" });

beforeEach(() => jest.clearAllMocks());

describe("FT-019 — delete a creation", () => {
  it("deletes the caller's creation and returns 204", async () => {
    creationsModel.deleteCreation.mockResolvedValue(true);
    const res = await request(app).delete("/api/creations/c-1").set("Authorization", `Bearer ${token("u1")}`);
    expect(res.status).toBe(204);
    expect(creationsModel.deleteCreation).toHaveBeenCalledWith("u1", "c-1"); // scoped to caller
  });

  it("returns 404 when the creation does not belong to the caller / does not exist", async () => {
    creationsModel.deleteCreation.mockResolvedValue(false);
    const res = await request(app).delete("/api/creations/nope").set("Authorization", `Bearer ${token("u1")}`);
    expect(res.status).toBe(404);
  });

  it("requires authentication", async () => {
    const res = await request(app).delete("/api/creations/c-1");
    expect(res.status).toBe(401);
  });
});

describe("IT-011 — one-time creations migration", () => {
  it("inserts valid records and reports the migrated count", async () => {
    creationsModel.addCreation.mockImplementation(async (c) => ({ id: "new", ...c }));
    const res = await request(app)
      .post("/api/creations/migrate")
      .set("Authorization", `Bearer ${token("u2")}`)
      .send({ creations: [
        { styleId: "s1", styleName: "A", imageUrl: "http://x/a.png" },
        { styleId: "s2", styleName: "B", imageUrl: "http://x/b.png" },
      ] });

    expect(res.status).toBe(201);
    expect(res.body.migrated).toBe(2);
    expect(creationsModel.addCreation).toHaveBeenCalledTimes(2);
    expect(creationsModel.addCreation.mock.calls[0][0].userId).toBe("u2"); // scoped to caller
  });

  it("skips malformed records instead of failing the whole migration", async () => {
    creationsModel.addCreation.mockImplementation(async (c) => ({ id: "new", ...c }));
    const res = await request(app)
      .post("/api/creations/migrate")
      .set("Authorization", `Bearer ${token("u2")}`)
      .send({ creations: [
        { styleName: "Good", imageUrl: "http://x/a.png" },
        { styleName: 123 }, // invalid -> skipped
        null, // invalid -> skipped
      ] });
    expect(res.status).toBe(201);
    expect(res.body.migrated).toBe(1);
  });

  it("rejects a non-array body and an over-limit batch", async () => {
    const bad = await request(app).post("/api/creations/migrate").set("Authorization", `Bearer ${token("u2")}`).send({ creations: "nope" });
    expect(bad.status).toBe(400);

    const tooMany = Array.from({ length: 501 }, (_, i) => ({ styleName: `S${i}`, imageUrl: "http://x" }));
    const over = await request(app).post("/api/creations/migrate").set("Authorization", `Bearer ${token("u2")}`).send({ creations: tooMany });
    expect(over.status).toBe(400);
  });
});
