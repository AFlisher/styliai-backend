// SEC-15.6: row visibility on the shared catalog reads is decided by the
// CALLER, not by the query string.
//
// GET /api/styles and GET /api/categories are shared between the mobile app
// and the dashboard via optionalAdminAuth. The response *columns* were already
// gated on req.admin; the *rows* were not - `?all=true` was honoured for
// anyone, and getCategories never filtered at all. The first test below is the
// one that was missing, and its absence is why the gap survived.

jest.mock("../../models/styleModel", () => ({
  getStyles: jest.fn().mockResolvedValue([]),
  getPublicStyles: jest.fn().mockResolvedValue([]),
}));
jest.mock("../../models/categoryModel", () => ({
  getAllCategories: jest.fn().mockResolvedValue([]),
  getPublicCategories: jest.fn().mockResolvedValue([]),
}));
jest.mock("../../services/recommendationService", () => ({
  isPersonalizationEnabled: jest.fn(),
  getPersonalizedRecommendations: jest.fn(),
  invalidateCandidateCache: jest.fn(),
}));

const styleModel = require("../../models/styleModel");
const categoryModel = require("../../models/categoryModel");
const { getStyles } = require("../styleController");
const { getCategories } = require("../categoryController");

const ADMIN = { id: "admin-1", role: "admin", adminRole: "viewer" };

function makeReqRes({ query = {}, admin } = {}) {
  const req = { query, ...(admin ? { admin } : {}) };
  const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
  return { req, res };
}

beforeEach(() => {
  jest.clearAllMocks();
  styleModel.getStyles.mockResolvedValue([]);
  styleModel.getPublicStyles.mockResolvedValue([]);
  categoryModel.getAllCategories.mockResolvedValue([]);
  categoryModel.getPublicCategories.mockResolvedValue([]);
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => console.error.mockRestore());

describe("GET /api/styles - ?all=true is gated on the caller (SEC-15.6)", () => {
  it("ignores ?all=true from a non-admin and still forces isEnabled", async () => {
    // THE regression test. Before the fix this called getPublicStyles({}),
    // handing every authenticated mobile user the unreleased catalog.
    const { req, res } = makeReqRes({ query: { all: "true" } });

    await getStyles(req, res);

    expect(styleModel.getPublicStyles).toHaveBeenCalledWith({ isEnabled: true });
    expect(styleModel.getStyles).not.toHaveBeenCalled();
  });

  it("still forces isEnabled when ?all=true is combined with categoryId", async () => {
    const { req, res } = makeReqRes({ query: { all: "true", categoryId: "cat-1" } });

    await getStyles(req, res);

    expect(styleModel.getPublicStyles).toHaveBeenCalledWith({
      categoryId: "cat-1",
      isEnabled: true,
    });
  });

  it("still forces isEnabled when ?all=true is combined with trending", async () => {
    const { req, res } = makeReqRes({ query: { all: "true", trending: "true" } });

    await getStyles(req, res);

    expect(styleModel.getPublicStyles).toHaveBeenCalledWith({
      isEnabled: true,
      isTrending: true,
    });
  });

  it.each([
    ["TRUE", "TRUE"],
    ["True", "True"],
    ["1", "1"],
    ["yes", "yes"],
    ["empty", ""],
  ])("ignores a non-admin ?all=%s", async (_label, value) => {
    // The comparison is an exact "true" match, so none of these widen the
    // filter - but a non-admin must be filtered regardless of what they send.
    const { req, res } = makeReqRes({ query: { all: value } });

    await getStyles(req, res);

    expect(styleModel.getPublicStyles).toHaveBeenCalledWith({ isEnabled: true });
  });

  it("honours ?all=true for an admin", async () => {
    const { req, res } = makeReqRes({ query: { all: "true" }, admin: ADMIN });

    await getStyles(req, res);

    expect(styleModel.getStyles).toHaveBeenCalledWith({});
    expect(styleModel.getPublicStyles).not.toHaveBeenCalled();
  });

  it("still defaults an admin to enabled-only when ?all is absent", async () => {
    // An admin browsing normally sees the same catalog a user does; the
    // parameter is what widens it, the token only permits the widening.
    const { req, res } = makeReqRes({ admin: ADMIN });

    await getStyles(req, res);

    expect(styleModel.getStyles).toHaveBeenCalledWith({ isEnabled: true });
  });

  it("does not take the admin flag from the query string", async () => {
    const { req, res } = makeReqRes({ query: { all: "true", admin: "true", isAdmin: "1" } });

    await getStyles(req, res);

    expect(styleModel.getPublicStyles).toHaveBeenCalledWith({ isEnabled: true });
  });
});

describe("GET /api/categories - disabled categories are admin-only (SEC-15.6)", () => {
  it("serves only enabled categories to a non-admin", async () => {
    // Before the fix this called getAllCategories unconditionally.
    const { req, res } = makeReqRes();

    await getCategories(req, res);

    expect(categoryModel.getPublicCategories).toHaveBeenCalledTimes(1);
    expect(categoryModel.getAllCategories).not.toHaveBeenCalled();
  });

  it("serves every category to an admin", async () => {
    const { req, res } = makeReqRes({ admin: ADMIN });

    await getCategories(req, res);

    expect(categoryModel.getAllCategories).toHaveBeenCalledTimes(1);
    expect(categoryModel.getPublicCategories).not.toHaveBeenCalled();
  });

  it("serves the admin view to a viewer-tier admin too", async () => {
    // Catalog reads are viewer-tier under SEC-15.4, so every admin tier sees
    // disabled rows. Pinned so a later change doesn't silently couple row
    // visibility to a higher tier.
    const { req, res } = makeReqRes({ admin: { id: "a", role: "admin", adminRole: "viewer" } });

    await getCategories(req, res);

    expect(categoryModel.getAllCategories).toHaveBeenCalledTimes(1);
  });

  it("does not take the admin flag from the query string", async () => {
    const { req, res } = makeReqRes({ query: { admin: "true", all: "true" } });

    await getCategories(req, res);

    expect(categoryModel.getPublicCategories).toHaveBeenCalledTimes(1);
    expect(categoryModel.getAllCategories).not.toHaveBeenCalled();
  });

  it("returns whatever the model returns, unchanged in shape", async () => {
    const rows = [{ id: "c1", name: "Portraits", sortOrder: 0, isEnabled: true }];
    categoryModel.getPublicCategories.mockResolvedValue(rows);
    const { req, res } = makeReqRes();

    await getCategories(req, res);

    expect(res.json).toHaveBeenCalledWith(rows);
  });
});
