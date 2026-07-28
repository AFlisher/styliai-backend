// SEC-15.6: getPublicCategories must filter rows without narrowing columns.

jest.mock("../../config/db", () => ({ query: jest.fn(), pool: { connect: jest.fn() } }));

const db = require("../../config/db");
const { getAllCategories, getPublicCategories } = require("../categoryModel");

/** Collapses whitespace so SQL can be compared without formatting noise. */
function normalize(sql) {
  return sql.replace(/\s+/g, " ").trim();
}

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe("getPublicCategories", () => {
  it("filters to enabled categories", async () => {
    await getPublicCategories();

    const sql = normalize(db.query.mock.calls[0][0]);
    expect(sql).toContain("WHERE is_enabled = true");
  });

  it("keeps the same ordering as the admin variant", async () => {
    await getPublicCategories();
    expect(normalize(db.query.mock.calls[0][0])).toContain("ORDER BY sort_order ASC");
  });

  it("selects exactly the same columns as getAllCategories", async () => {
    // The variant restricts which ROWS are visible, not which fields - the
    // mobile app's response shape must not change. A narrower column list here
    // would be a silent breaking change rather than a security improvement.
    await getAllCategories();
    const adminSql = normalize(db.query.mock.calls[0][0]);

    jest.clearAllMocks();
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });

    await getPublicCategories();
    const publicSql = normalize(db.query.mock.calls[0][0]);

    const columnsOf = (sql) => sql.slice(sql.indexOf("SELECT") + 6, sql.indexOf("FROM")).trim();
    expect(columnsOf(publicSql)).toBe(columnsOf(adminSql));
  });

  it("takes no parameters, so nothing caller-controlled reaches the query", async () => {
    await getPublicCategories();
    expect(db.query.mock.calls[0][1]).toBeUndefined();
  });
});

describe("getAllCategories", () => {
  it("does not filter, so the dashboard still sees disabled categories", async () => {
    await getAllCategories();
    expect(normalize(db.query.mock.calls[0][0])).not.toContain("WHERE");
  });
});
