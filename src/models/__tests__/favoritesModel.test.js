jest.mock("../../config/db", () => ({
  query: jest.fn(),
}));

const db = require("../../config/db");
const { getFavoriteStyleIds, addFavorite, removeFavorite } = require("../favoritesModel");

describe("favoritesModel", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("getFavoriteStyleIds", () => {
    it("returns just the style ids, newest first", async () => {
      db.query.mockResolvedValue({ rows: [{ styleId: "s2" }, { styleId: "s1" }] });

      const ids = await getFavoriteStyleIds("user-1");

      expect(ids).toEqual(["s2", "s1"]);
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining("FROM favorites WHERE user_id = $1"),
        ["user-1"]
      );
    });
  });

  describe("addFavorite", () => {
    it("inserts with ON CONFLICT DO NOTHING so re-favoriting is idempotent", async () => {
      db.query.mockResolvedValue({ rows: [] });

      await addFavorite("user-1", "style-1");

      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining("ON CONFLICT (user_id, style_id) DO NOTHING"),
        ["user-1", "style-1"]
      );
    });
  });

  describe("removeFavorite", () => {
    it("deletes scoped to both user_id and style_id", async () => {
      db.query.mockResolvedValue({ rows: [] });

      await removeFavorite("user-1", "style-1");

      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining("DELETE FROM favorites WHERE user_id = $1 AND style_id = $2"),
        ["user-1", "style-1"]
      );
    });
  });
});
