jest.mock("../../config/db", () => ({
  query: jest.fn(),
}));
// adminStatsController also pulls in config/supabase for getStats' storage
// lookup (unused by getUsersByCountry) - stub it out so this suite doesn't
// need real SUPABASE_URL/SUPABASE_SERVICE_KEY env vars to load the module.
jest.mock("../../config/supabase", () => ({}));

const db = require("../../config/db");
const { getUsersByCountry } = require("../adminStatsController");

function makeReqRes({ query = {} } = {}) {
  const req = { query };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  return { req, res };
}

describe("adminStatsController.getUsersByCountry", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    console.error.mockRestore();
  });

  it("defaults to allTime and returns the aggregated rows", async () => {
    const rows = [
      { countryCode: "US", countryName: "United States", userCount: 8, percentage: 80 },
      { countryCode: "CA", countryName: "Canada", userCount: 2, percentage: 20 },
    ];
    db.query.mockResolvedValue({ rows });
    const { req, res } = makeReqRes();

    await getUsersByCountry(req, res);

    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql] = db.query.mock.calls[0];
    expect(sql).toContain("country_code IS NOT NULL");
    expect(sql).toContain("GROUP BY country_code, country_name");
    expect(sql).toContain("ORDER BY \"userCount\" DESC");
    expect(sql).not.toContain("CURRENT_DATE");
    expect(res.json).toHaveBeenCalledWith({ range: "allTime", countries: rows });
  });

  it.each([
    ["today", "created_at >= CURRENT_DATE"],
    ["last7days", "created_at >= CURRENT_DATE - INTERVAL '6 days'"],
    ["last30days", "created_at >= CURRENT_DATE - INTERVAL '29 days'"],
  ])("applies the %s date filter", async (range, expectedClause) => {
    db.query.mockResolvedValue({ rows: [] });
    const { req, res } = makeReqRes({ query: { range } });

    await getUsersByCountry(req, res);

    const [sql] = db.query.mock.calls[0];
    expect(sql).toContain(expectedClause);
    expect(res.json).toHaveBeenCalledWith({ range, countries: [] });
  });

  it("rejects an invalid range without querying the database", async () => {
    const { req, res } = makeReqRes({ query: { range: "lastWeek" } });

    await getUsersByCountry(req, res);

    expect(db.query).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("Invalid range") })
    );
  });

  it("returns 500 when the query fails", async () => {
    db.query.mockRejectedValue(new Error("db down"));
    const { req, res } = makeReqRes();

    await getUsersByCountry(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.any(String) })
    );
  });
});
