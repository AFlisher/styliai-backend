jest.mock("../../models/favoritesModel", () => ({
  getFavoriteStyleIds: jest.fn(),
  addFavorite: jest.fn(),
  removeFavorite: jest.fn(),
}));

const favoritesModel = require("../../models/favoritesModel");
const { getFavorites, addFavorite, removeFavorite } = require("../favoritesController");

function makeReqRes({ params = {}, body = {} } = {}) {
  const req = { user: { id: "user-1" }, params, body };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn(), send: jest.fn() };
  return { req, res };
}

describe("favoritesController", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    console.error.mockRestore();
  });

  describe("getFavorites", () => {
    it("returns the current user's favorite style ids", async () => {
      favoritesModel.getFavoriteStyleIds.mockResolvedValue(["s1", "s2"]);
      const { req, res } = makeReqRes();

      await getFavorites(req, res);

      expect(favoritesModel.getFavoriteStyleIds).toHaveBeenCalledWith("user-1");
      expect(res.json).toHaveBeenCalledWith({ styleIds: ["s1", "s2"] });
    });
  });

  describe("addFavorite", () => {
    it("requires styleId", async () => {
      const { req, res } = makeReqRes({ body: {} });

      await addFavorite(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(favoritesModel.addFavorite).not.toHaveBeenCalled();
    });

    it("adds the favorite and returns 201", async () => {
      const { req, res } = makeReqRes({ body: { styleId: "550e8400-e29b-41d4-a716-446655440000" } });

      await addFavorite(req, res);

      expect(favoritesModel.addFavorite).toHaveBeenCalledWith("user-1", "550e8400-e29b-41d4-a716-446655440000");
      expect(res.status).toHaveBeenCalledWith(201);
    });

    it("maps a foreign-key violation (nonexistent style) to 404", async () => {
      const fkErr = new Error("violates foreign key constraint");
      fkErr.code = "23503";
      favoritesModel.addFavorite.mockRejectedValue(fkErr);
      const { req, res } = makeReqRes({ body: { styleId: "77777777-7777-4777-8777-777777777777" } });

      await addFavorite(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe("removeFavorite", () => {
    it("removes the favorite and returns 204", async () => {
      const { req, res } = makeReqRes({ params: { styleId: "550e8400-e29b-41d4-a716-446655440000" } });

      await removeFavorite(req, res);

      expect(favoritesModel.removeFavorite).toHaveBeenCalledWith("user-1", "550e8400-e29b-41d4-a716-446655440000");
      expect(res.status).toHaveBeenCalledWith(204);
    });
  });
});
