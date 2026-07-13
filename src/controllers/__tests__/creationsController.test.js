jest.mock("../../models/creationsModel", () => ({
  getCreationsByUser: jest.fn(),
  addCreation: jest.fn(),
  deleteCreation: jest.fn(),
}));

const creationsModel = require("../../models/creationsModel");
const { getCreations, deleteCreation, migrateCreations } = require("../creationsController");

function makeReqRes({ params = {}, body = {} } = {}) {
  const req = { user: { id: "user-1" }, params, body };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn(), send: jest.fn() };
  return { req, res };
}

describe("creationsController", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    console.error.mockRestore();
  });

  describe("getCreations", () => {
    it("returns the current user's creations", async () => {
      creationsModel.getCreationsByUser.mockResolvedValue([{ id: "c1" }]);
      const { req, res } = makeReqRes();

      await getCreations(req, res);

      expect(creationsModel.getCreationsByUser).toHaveBeenCalledWith("user-1");
      expect(res.json).toHaveBeenCalledWith([{ id: "c1" }]);
    });
  });

  describe("deleteCreation", () => {
    it("returns 204 when the row belonged to this user and was deleted", async () => {
      creationsModel.deleteCreation.mockResolvedValue({ id: "c1" });
      const { req, res } = makeReqRes({ params: { id: "c1" } });

      await deleteCreation(req, res);

      expect(creationsModel.deleteCreation).toHaveBeenCalledWith("user-1", "c1");
      expect(res.status).toHaveBeenCalledWith(204);
    });

    it("returns 404 when nothing was deleted (wrong user or nonexistent id)", async () => {
      creationsModel.deleteCreation.mockResolvedValue(undefined);
      const { req, res } = makeReqRes({ params: { id: "not-mine" } });

      await deleteCreation(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe("migrateCreations", () => {
    it("rejects a non-array body with 400", async () => {
      const { req, res } = makeReqRes({ body: { creations: "not-an-array" } });

      await migrateCreations(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(creationsModel.addCreation).not.toHaveBeenCalled();
    });

    it("rejects a batch larger than the max size", async () => {
      const creations = Array.from({ length: 501 }, (_, i) => ({
        styleName: `s${i}`,
        imageUrl: "url",
      }));
      const { req, res } = makeReqRes({ body: { creations } });

      await migrateCreations(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(creationsModel.addCreation).not.toHaveBeenCalled();
    });

    it("skips malformed items but inserts the valid ones", async () => {
      creationsModel.addCreation.mockResolvedValue({ id: "new-1" });
      const { req, res } = makeReqRes({
        body: {
          creations: [
            { styleName: "Valid", imageUrl: "url1" },
            { styleName: "Missing image url" },
            null,
          ],
        },
      });

      await migrateCreations(req, res);

      expect(creationsModel.addCreation).toHaveBeenCalledTimes(1);
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith({ migrated: 1, creations: [{ id: "new-1" }] });
    });

    it("continues migrating remaining items when one insert throws (e.g. a deleted style's FK)", async () => {
      creationsModel.addCreation
        .mockRejectedValueOnce(new Error("foreign key violation"))
        .mockResolvedValueOnce({ id: "new-2" });
      const { req, res } = makeReqRes({
        body: {
          creations: [
            { styleId: "deleted-style", styleName: "Old", imageUrl: "url1" },
            { styleName: "Fine", imageUrl: "url2" },
          ],
        },
      });

      await migrateCreations(req, res);

      expect(creationsModel.addCreation).toHaveBeenCalledTimes(2);
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith({ migrated: 1, creations: [{ id: "new-2" }] });
    });
  });
});
