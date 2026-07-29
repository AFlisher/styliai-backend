// SEC-8.1A — the DELETE's RETURNING clause.
//
// This exists because of a specific silent-regression risk. The controller
// erases whatever URLs the model hands back, and the controller's own tests
// mock the model - so narrowing this RETURNING to `id` again would disable
// storage erasure completely while every other suite stayed green. The
// erasure is only as good as the row that feeds it.

jest.mock("../../config/db", () => ({ query: jest.fn() }));

const db = require("../../config/db");
const creationsModel = require("../creationsModel");

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockResolvedValue({ rows: [] });
});

describe("deleteCreation", () => {
  it("returns the stored URLs the erasure path needs", async () => {
    await creationsModel.deleteCreation("u-1", "c-1");

    const [sql] = db.query.mock.calls[0];
    expect(sql).toMatch(/RETURNING[\s\S]*image_url\s+AS\s+"imageUrl"/i);
    expect(sql).toMatch(/thumbnail_url\s+AS\s+"thumbnailUrl"/i);
  });

  it("stays scoped to the calling user", async () => {
    // Widening the RETURNING must not have widened the predicate: this is the
    // only ownership check standing between a caller and another user's row -
    // and now, between them and another user's stored objects.
    await creationsModel.deleteCreation("u-1", "c-1");

    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/WHERE id = \$1 AND user_id = \$2/);
    expect(params).toEqual(["c-1", "u-1"]);
  });

  it("returns undefined when nothing matched, so no erasure is attempted", async () => {
    await expect(creationsModel.deleteCreation("u-1", "nope")).resolves.toBeUndefined();
  });
});
