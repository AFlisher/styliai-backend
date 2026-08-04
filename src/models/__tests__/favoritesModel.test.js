jest.mock("../../config/db", () => ({
  query: jest.fn(),
}));

const db = require("../../config/db");
const { getFavoriteStyleIds, addFavorite, removeFavorite } = require("../favoritesModel");
const { FAVORITES_PAGE_MAX } = require("../../utils/pagination");

describe("favoritesModel", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("getFavoriteStyleIds", () => {
    it("returns just the style ids, newest first", async () => {
      db.query.mockResolvedValue({ rows: [{ styleId: "s2" }, { styleId: "s1" }] });

      const ids = await getFavoriteStyleIds("user-1");

      expect(ids).toEqual(["s2", "s1"]);
      // SEC-19.2: the query is now bounded. The user scoping this test exists
      // to protect is unchanged and still asserted; the LIMIT is the addition.
      expect(db.query.mock.calls[0][0]).toEqual(expect.stringContaining("FROM favorites"));
      expect(db.query.mock.calls[0][0]).toEqual(expect.stringContaining("WHERE user_id = $1"));
      expect(db.query.mock.calls[0][0]).toEqual(expect.stringContaining("LIMIT $2"));
      expect(db.query.mock.calls[0][1]).toEqual(["user-1", FAVORITES_PAGE_MAX]);
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
