jest.mock("../../services/recommendationService", () => ({
  getSimilarStyles: jest.fn(),
}));

const recommendationService = require("../../services/recommendationService");
const { getSimilarStyles } = require("../recommendationController");

function makeReqRes({ params = {}, query = {} } = {}) {
  const req = { params, query };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  return { req, res };
}

describe("recommendationController.getSimilarStyles", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    console.error.mockRestore();
  });

  it("works for an anonymous request (no auth required)", async () => {
    recommendationService.getSimilarStyles.mockResolvedValue([{ id: "s2" }]);
    const { req, res } = makeReqRes({ params: { id: "s1" } });

    await getSimilarStyles(req, res);

    expect(recommendationService.getSimilarStyles).toHaveBeenCalledWith({ styleId: "s1", limit: 10 });
    expect(res.json).toHaveBeenCalledWith([{ id: "s2" }]);
  });

  it("respects a custom ?limit=", async () => {
    recommendationService.getSimilarStyles.mockResolvedValue([]);
    const { req, res } = makeReqRes({ params: { id: "s1" }, query: { limit: "3" } });

    await getSimilarStyles(req, res);

    expect(recommendationService.getSimilarStyles).toHaveBeenCalledWith({ styleId: "s1", limit: 3 });
  });

  it("returns 404 when the style doesn't exist or is disabled", async () => {
    recommendationService.getSimilarStyles.mockResolvedValue(null);
    const { req, res } = makeReqRes({ params: { id: "missing" } });

    await getSimilarStyles(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });
});
