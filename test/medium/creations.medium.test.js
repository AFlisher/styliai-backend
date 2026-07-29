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
// SEC-8.1A — the cleanup service has its own unit suite
// (src/services/__tests__/creationAssetCleanup.test.js); what matters at this
// level is the wiring: that the controller hands it the deleted row's URLs and
// that its outcome never leaks into the HTTP contract.
jest.mock("../../src/services/creationAssetCleanup", () => ({
  deleteCreationAssets: jest.fn().mockResolvedValue({ deleted: 0, skipped: [] }),
}));

const jwt = require("jsonwebtoken");
const request = require("supertest");
const app = require("../../src/app");
const creationsModel = require("../../src/models/creationsModel");
const creationAssetCleanup = require("../../src/services/creationAssetCleanup");

const token = (id) => jwt.sign({ sub: id, email: `${id}@x.com`, role: "authenticated", aud: "authenticated", type: "access" }, process.env.SUPABASE_JWT_SECRET, { expiresIn: "1h" });

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

describe("SEC-8.1A — deleting a creation erases its stored objects", () => {
  const row = {
    id: "c-1",
    imageUrl: "https://p.supabase.co/storage/v1/object/public/creations/a.webp",
    thumbnailUrl: "https://p.supabase.co/storage/v1/object/public/creations/thumbs/a.webp",
  };

  it("hands the cleanup both stored URLs from the deleted row", async () => {
    creationsModel.deleteCreation.mockResolvedValue(row);

    const res = await request(app).delete("/api/creations/c-1").set("Authorization", `Bearer ${token("u1")}`);

    expect(res.status).toBe(204);
    expect(creationAssetCleanup.deleteCreationAssets).toHaveBeenCalledWith({
      creationId: "c-1",
      urls: [row.imageUrl, row.thumbnailUrl],
    });
  });

  it("does not touch storage when the row was not the caller's", async () => {
    // Ownership is enforced by the DELETE's own user_id predicate: no row comes
    // back, so nothing is erased. Erasing before confirming the delete matched
    // would be a cross-user destructive bug.
    creationsModel.deleteCreation.mockResolvedValue(undefined);

    const res = await request(app).delete("/api/creations/c-1").set("Authorization", `Bearer ${token("u1")}`);

    expect(res.status).toBe(404);
    expect(creationAssetCleanup.deleteCreationAssets).not.toHaveBeenCalled();
  });

  it("still returns 204 when erasure fails", async () => {
    // The row is already gone and the creation has left the user's gallery, so
    // their deletion did succeed. A 500 here would invite a retry that 404s
    // while the orphan survives either way; the reconciler is the recovery path.
    creationsModel.deleteCreation.mockResolvedValue(row);
    creationAssetCleanup.deleteCreationAssets.mockResolvedValue({ deleted: 0, skipped: [], failed: true });

    const res = await request(app).delete("/api/creations/c-1").set("Authorization", `Bearer ${token("u1")}`);

    expect(res.status).toBe(204);
  });

  it("still returns 204 if the cleanup throws despite its contract", async () => {
    creationsModel.deleteCreation.mockResolvedValue(row);
    creationAssetCleanup.deleteCreationAssets.mockRejectedValue(new Error("unexpected"));

    const res = await request(app).delete("/api/creations/c-1").set("Authorization", `Bearer ${token("u1")}`);

    // deleteCreationAssets is written never to throw and its unit suite pins
    // that, but a future bug must not be able to answer 500 to a deletion that
    // already succeeded - hence the controller's inner catch.
    expect(res.status).toBe(204);
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
