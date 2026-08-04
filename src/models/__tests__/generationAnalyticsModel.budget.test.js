jest.mock("../../config/db", () => ({
  query: jest.fn(),
  analyticsQuery: jest.fn().mockResolvedValue({ rows: [{}] }),
}));

const db = require("../../config/db");
const model = require("../generationAnalyticsModel");

/**
 * SEC-19.3 coverage gap this suite exists to close.
 *
 * Every existing test of this model's callers mocks the MODEL, so nothing
 * exercised which db function the model itself calls. That mattered: routing
 * the widest aggregates in the codebase through the scoped analytics budget is
 * the reason the global statement_timeout could be set to an OLTP-sized value
 * at all, and it would have shipped unverified.
 */
describe("SEC-19.3 — admin analytics use the scoped statement budget", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.analyticsQuery.mockResolvedValue({ rows: [{}] });
  });

  const cases = [
    ["getOverview", () => model.getOverview()],
    ["getTopStyles", () => model.getTopStyles("last7days", 10)],
    ["getTopCategories", () => model.getTopCategories("last7days", 10)],
    ["getRatedStyles", () => model.getRatedStyles("last7days", 3, "desc", 10)],
    ["getGenerationTimeStats", () => model.getGenerationTimeStats("last7days")],
    ["getFeedbackSummary", () => model.getFeedbackSummary("last7days")],
    ["getRecentFeedback", () => model.getRecentFeedback("last7days", 20)],
  ];

  it.each(cases)("%s goes through analyticsQuery, not the default pool query", async (_name, call) => {
    await call();
    expect(db.analyticsQuery).toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });

  // VACUITY: if analyticsQuery and query were the same jest.fn, the assertion
  // above would pass no matter which the model called.
  it("VACUITY: the two db functions are distinct spies", () => {
    expect(db.analyticsQuery).not.toBe(db.query);
  });

  it("VACUITY: the model really does issue a query per call", async () => {
    await model.getOverview();
    expect(db.analyticsQuery).toHaveBeenCalledTimes(1);
  });
});

describe("SEC-19.3 — the analytics budget is larger than the OLTP default", () => {
  it("is configured above the pool-wide statement_timeout", () => {
    // Loaded without the module mock above, since these are the real values.
    const real = jest.requireActual("../../config/db");
    const poolTimeout = real.buildPoolConfig({ DATABASE_URL: "postgres://x/y" })
      .statement_timeout;
    expect(real.ANALYTICS_STATEMENT_TIMEOUT_MS).toBeGreaterThan(poolTimeout);
  });
});
