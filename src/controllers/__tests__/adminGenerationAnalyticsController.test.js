jest.mock("../../models/generationAnalyticsModel", () => ({
  STATS_RANGES: new Set(["today", "last7days", "last30days", "allTime"]),
  getOverview: jest.fn(),
  getTopStyles: jest.fn(),
  getTopCategories: jest.fn(),
  getRatedStyles: jest.fn(),
  getGenerationTimeStats: jest.fn(),
  getFeedbackSummary: jest.fn(),
  getRecentFeedback: jest.fn(),
}));

const generationAnalyticsModel = require("../../models/generationAnalyticsModel");
const { getOverview, getSummary } = require("../adminGenerationAnalyticsController");

function makeReqRes({ query = {} } = {}) {
  const req = { query };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  return { req, res };
}

describe("adminGenerationAnalyticsController.getOverview", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    console.error.mockRestore();
  });

  it("returns the overview payload", async () => {
    const overview = {
      totalGenerations: 100,
      todayGenerations: 5,
      thisWeekGenerations: 20,
      thisMonthGenerations: 60,
      activeUsersToday: 3,
      activeUsersThisMonth: 15,
    };
    generationAnalyticsModel.getOverview.mockResolvedValue(overview);
    const { req, res } = makeReqRes();

    await getOverview(req, res);

    expect(res.json).toHaveBeenCalledWith(overview);
  });

  it("returns 500 when the query fails", async () => {
    generationAnalyticsModel.getOverview.mockRejectedValue(new Error("db down"));
    const { req, res } = makeReqRes();

    await getOverview(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe("adminGenerationAnalyticsController.getSummary", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "error").mockImplementation(() => {});
    generationAnalyticsModel.getTopStyles.mockResolvedValue([]);
    generationAnalyticsModel.getTopCategories.mockResolvedValue([]);
    generationAnalyticsModel.getRatedStyles.mockResolvedValue([]);
    generationAnalyticsModel.getGenerationTimeStats.mockResolvedValue({
      avgMs: null,
      sampleCount: 0,
      fastestStyle: null,
      slowestStyle: null,
    });
    generationAnalyticsModel.getFeedbackSummary.mockResolvedValue({
      avgRating: null,
      totalFeedback: 0,
      distribution: { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 },
    });
    generationAnalyticsModel.getRecentFeedback.mockResolvedValue([]);
  });

  afterEach(() => {
    console.error.mockRestore();
  });

  it("defaults to allTime range and minFeedbackCount of 10", async () => {
    const { req, res } = makeReqRes();

    await getSummary(req, res);

    expect(generationAnalyticsModel.getTopStyles).toHaveBeenCalledWith("allTime");
    expect(generationAnalyticsModel.getRatedStyles).toHaveBeenCalledWith("allTime", 10, "desc");
    expect(generationAnalyticsModel.getRatedStyles).toHaveBeenCalledWith("allTime", 10, "asc");
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ range: "allTime", minFeedbackCount: 10 })
    );
  });

  it("passes through a valid range and custom minFeedbackCount", async () => {
    const { req, res } = makeReqRes({ query: { range: "last7days", minFeedbackCount: "5" } });

    await getSummary(req, res);

    expect(generationAnalyticsModel.getTopStyles).toHaveBeenCalledWith("last7days");
    expect(generationAnalyticsModel.getRatedStyles).toHaveBeenCalledWith("last7days", 5, "desc");
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ range: "last7days", minFeedbackCount: 5 })
    );
  });

  it("rejects an invalid range without querying", async () => {
    const { req, res } = makeReqRes({ query: { range: "lastWeek" } });

    await getSummary(req, res);

    expect(generationAnalyticsModel.getTopStyles).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("ignores an invalid minFeedbackCount and falls back to the default", async () => {
    const { req, res } = makeReqRes({ query: { minFeedbackCount: "not-a-number" } });

    await getSummary(req, res);

    expect(generationAnalyticsModel.getRatedStyles).toHaveBeenCalledWith("allTime", 10, "desc");
  });

  it("returns 500 when a query fails", async () => {
    generationAnalyticsModel.getTopStyles.mockRejectedValue(new Error("db down"));
    const { req, res } = makeReqRes();

    await getSummary(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});
