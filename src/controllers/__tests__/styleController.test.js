jest.mock("../../models/styleModel", () => ({
  getStyles: jest.fn(),
  getPublicStyles: jest.fn(),
}));

const styleModel = require("../../models/styleModel");
const { getStyles } = require("../styleController");

function makeReqRes({ query = {}, admin } = {}) {
  const req = { query, admin };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  return { req, res };
}

const FULL_STYLE = { id: "s1", name: "Style 1", prompt: "a secret prompt", negativePrompt: null };
const PUBLIC_STYLE = { id: "s1", name: "Style 1" };

describe("styleController.getStyles - public/admin DTO split", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    styleModel.getStyles.mockResolvedValue([FULL_STYLE]);
    styleModel.getPublicStyles.mockResolvedValue([PUBLIC_STYLE]);
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    console.error.mockRestore();
  });

  it("returns the public (prompt-stripped) DTO when req.admin is not set", async () => {
    const { req, res } = makeReqRes({});

    await getStyles(req, res);

    expect(styleModel.getPublicStyles).toHaveBeenCalledTimes(1);
    expect(styleModel.getStyles).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith([PUBLIC_STYLE]);
  });

  it("returns the full admin DTO (including prompt) when req.admin is set", async () => {
    const { req, res } = makeReqRes({ admin: { id: "admin-1", role: "admin" } });

    await getStyles(req, res);

    expect(styleModel.getStyles).toHaveBeenCalledTimes(1);
    expect(styleModel.getPublicStyles).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith([FULL_STYLE]);
  });

  it("still applies categoryId/isEnabled filters identically for both DTO paths", async () => {
    const { req, res } = makeReqRes({ query: { categoryId: "cat-1" } });
    req.query = { categoryId: "cat-1" };

    await getStyles(req, res);

    expect(styleModel.getPublicStyles).toHaveBeenCalledWith({ categoryId: "cat-1", isEnabled: true });
  });

  it("admin path honors ?all=true to include disabled styles, same as before", async () => {
    const { req, res } = makeReqRes({ admin: { id: "admin-1", role: "admin" } });
    req.query = { all: "true" };

    await getStyles(req, res);

    expect(styleModel.getStyles).toHaveBeenCalledWith({});
  });
});
