jest.mock("../../config/db", () => ({
  query: jest.fn(),
}));

const db = require("../../config/db");
const { getCreationsByUser, addCreation, deleteCreation } = require("../creationsModel");

describe("creationsModel", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("getCreationsByUser", () => {
    it("returns creations for the given user, newest first", async () => {
      const rows = [{ id: "c2", styleId: "s1", styleName: "Style", imageUrl: "url", createdAt: "t" }];
      db.query.mockResolvedValue({ rows });

      const result = await getCreationsByUser("user-1");

      expect(result).toEqual(rows);
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining("FROM creations"),
        ["user-1"]
      );
      expect(db.query.mock.calls[0][0]).toEqual(expect.stringContaining("WHERE user_id = $1"));
      expect(db.query.mock.calls[0][0]).toEqual(expect.stringContaining("ORDER BY created_at DESC"));
    });
  });

  describe("addCreation", () => {
    it("inserts with the given fields and returns the new row", async () => {
      const row = { id: "c1", styleId: "s1", styleName: "Style", imageUrl: "url", createdAt: "t" };
      db.query.mockResolvedValue({ rows: [row] });

      const result = await addCreation({
        userId: "user-1",
        styleId: "s1",
        styleName: "Style",
        imageUrl: "url",
      });

      expect(result).toEqual(row);
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO creations"),
        ["user-1", "s1", "Style", "url", null]
      );
    });

    it("defaults styleId to null when not provided (e.g. a deleted style)", async () => {
      db.query.mockResolvedValue({ rows: [{ id: "c1" }] });

      await addCreation({ userId: "user-1", styleName: "Style", imageUrl: "url" });

      expect(db.query).toHaveBeenCalledWith(
        expect.any(String),
        ["user-1", null, "Style", "url", null]
      );
    });

    it("passes through an explicit createdAt for migrated legacy creations", async () => {
      db.query.mockResolvedValue({ rows: [{ id: "c1" }] });

      await addCreation({
        userId: "user-1",
        styleName: "Style",
        imageUrl: "url",
        createdAt: "2024-01-01T00:00:00.000Z",
      });

      expect(db.query).toHaveBeenCalledWith(
        expect.any(String),
        ["user-1", null, "Style", "url", "2024-01-01T00:00:00.000Z"]
      );
    });
  });

  describe("deleteCreation", () => {
    it("deletes scoped to both id and user_id, so a user can't delete another user's row", async () => {
      db.query.mockResolvedValue({ rows: [{ id: "c1" }] });

      const result = await deleteCreation("user-1", "c1");

      expect(result).toEqual({ id: "c1" });
      expect(db.query).toHaveBeenCalledWith(
        expect.stringContaining("WHERE id = $1 AND user_id = $2"),
        ["c1", "user-1"]
      );
    });

    it("returns undefined when no row matches (wrong user or nonexistent id)", async () => {
      db.query.mockResolvedValue({ rows: [] });

      const result = await deleteCreation("user-1", "not-mine");

      expect(result).toBeUndefined();
    });
  });
});
