/**
 * High-priority catalog/read-endpoint suite (QA_TEST_PLAN.md):
 *   FT-014, FT-015, API-016, FT-022, IT-005, IT-012
 *
 * These endpoints delegate to models/services; those seams are mocked so the
 * assertions target routing, optional-auth wiring, filter construction, and
 * response contract - not the persistence layer.
 */

require("../critical/setupEnv");

jest.mock("../../src/config/db", () => require("../critical/fakeDb"));
jest.mock("../../src/config/supabase", () => ({ storage: { from: () => ({}) } }));

jest.mock("../../src/models/categoryModel", () => ({
  getAllCategories: jest.fn(),
}));
jest.mock("../../src/models/styleModel", () => ({
  getPublicStyles: jest.fn(),
  getStyles: jest.fn(),
  updateStyle: jest.fn(),
}));
jest.mock("../../src/models/creditPackModel", () => ({
  getCreditPacks: jest.fn(),
}));
jest.mock("../../src/services/recommendationService", () => ({
  isPersonalizationEnabled: jest.fn(),
  getPersonalizedRecommendations: jest.fn(),
  getSimilarStyles: jest.fn(),
  invalidateCandidateCache: jest.fn(),
}));

const jwt = require("jsonwebtoken");
const request = require("supertest");
const app = require("../../src/app");
const categoryModel = require("../../src/models/categoryModel");
const styleModel = require("../../src/models/styleModel");
const creditPackModel = require("../../src/models/creditPackModel");
const recommendationService = require("../../src/services/recommendationService");

const userToken = (id) =>
  jwt.sign({ sub: id, email: `${id}@x.com`, role: "authenticated" }, process.env.SUPABASE_JWT_SECRET, { expiresIn: "1h" });
const adminToken = () =>
  jwt.sign({ sub: "admin-1", email: "a@x.com", role: "admin" }, process.env.ADMIN_JWT_SECRET, { expiresIn: "2h" });

beforeEach(() => jest.clearAllMocks());

describe("FT-014 — GET /api/categories", () => {
  it("rejects an anonymous caller with 401 (guests never see Categories)", async () => {
    const res = await request(app).get("/api/categories");
    expect(res.status).toBe(401);
    expect(categoryModel.getAllCategories).not.toHaveBeenCalled();
  });

  it("returns the category list for an authenticated mobile user", async () => {
    categoryModel.getAllCategories.mockResolvedValue([
      { id: "c1", name: "Portraits", isEnabled: true, sortOrder: 0 },
      { id: "c2", name: "Anime", isEnabled: true, sortOrder: 1 },
    ]);
    const res = await request(app)
      .get("/api/categories")
      .set("Authorization", `Bearer ${userToken("u1")}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].name).toBe("Portraits");
  });

  it("returns the category list for the Admin Dashboard's admin token", async () => {
    categoryModel.getAllCategories.mockResolvedValue([{ id: "c1", name: "Portraits", isEnabled: true, sortOrder: 0 }]);
    const res = await request(app)
      .get("/api/categories")
      .set("Authorization", `Bearer ${adminToken()}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });
});

describe("FT-015 / API-016 — style listing filters", () => {
  it("rejects an anonymous caller with 401 (guests never see Styles)", async () => {
    const res = await request(app).get("/api/styles?trending=true");
    expect(res.status).toBe(401);
    expect(styleModel.getPublicStyles).not.toHaveBeenCalled();
  });

  it("?trending=true requests only enabled, trending styles (public DTO) for an authenticated user", async () => {
    styleModel.getPublicStyles.mockResolvedValue([{ id: "s1", name: "Trend", isTrending: true }]);
    const res = await request(app)
      .get("/api/styles?trending=true")
      .set("Authorization", `Bearer ${userToken("u1")}`);
    expect(res.status).toBe(200);
    expect(styleModel.getPublicStyles).toHaveBeenCalledWith({ isEnabled: true, isTrending: true });
    expect(styleModel.getStyles).not.toHaveBeenCalled(); // no admin token -> public path
  });

  it("?categoryId=... requests that category's enabled styles for an authenticated user", async () => {
    styleModel.getPublicStyles.mockResolvedValue([]);
    await request(app)
      .get("/api/styles?categoryId=cat-9")
      .set("Authorization", `Bearer ${userToken("u1")}`);
    expect(styleModel.getPublicStyles).toHaveBeenCalledWith({ categoryId: "cat-9", isEnabled: true });
  });

  it("?recommended=true returns [] when personalization is disabled", async () => {
    recommendationService.isPersonalizationEnabled.mockResolvedValue(false);
    const res = await request(app).get("/api/styles?recommended=true").set("Authorization", `Bearer ${userToken("u1")}`);
    expect(res.body).toEqual([]);
    expect(recommendationService.getPersonalizedRecommendations).not.toHaveBeenCalled();
  });

  it("?recommended=true returns ranked styles when personalization is on", async () => {
    recommendationService.isPersonalizationEnabled.mockResolvedValue(true);
    recommendationService.getPersonalizedRecommendations.mockResolvedValue([{ id: "r1" }, { id: "r2" }]);
    const res = await request(app).get("/api/styles?recommended=true").set("Authorization", `Bearer ${userToken("u1")}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(recommendationService.getPersonalizedRecommendations).toHaveBeenCalledWith({ userId: "u1" });
  });
});

describe("API-016 — GET /api/styles/:id/similar", () => {
  it("rejects an anonymous caller with 401", async () => {
    const res = await request(app).get("/api/styles/abc/similar?limit=5");
    expect(res.status).toBe(401);
    expect(recommendationService.getSimilarStyles).not.toHaveBeenCalled();
  });

  it("returns ranked similar styles for an authenticated user", async () => {
    recommendationService.getSimilarStyles.mockResolvedValue([{ id: "sim1" }]);
    const res = await request(app)
      .get("/api/styles/abc/similar?limit=5")
      .set("Authorization", `Bearer ${userToken("u1")}`);
    expect(res.status).toBe(200);
    expect(recommendationService.getSimilarStyles).toHaveBeenCalledWith({ styleId: "abc", limit: 5 });
    expect(res.body).toHaveLength(1);
  });

  it("returns 404 for an unknown anchor style", async () => {
    recommendationService.getSimilarStyles.mockResolvedValue(null);
    const res = await request(app)
      .get("/api/styles/missing/similar")
      .set("Authorization", `Bearer ${userToken("u1")}`);
    expect(res.status).toBe(404);
  });
});

describe("FT-022 / IT-005 — admin toggles trending; the trending filter reflects it", () => {
  it("admin PUT updates the style, and the trending read filters by isTrending", async () => {
    styleModel.updateStyle.mockResolvedValue({ id: "s7", isTrending: true });
    const put = await request(app)
      .put("/api/styles/s7")
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({ categoryId: "cat-1", name: "Trendy", prompt: "p", isTrending: true, autoAssignTags: false });
    expect(put.status).toBe(200);
    expect(styleModel.updateStyle).toHaveBeenCalled();

    styleModel.getPublicStyles.mockResolvedValue([{ id: "s7", isTrending: true }]);
    const list = await request(app)
      .get("/api/styles?trending=true")
      .set("Authorization", `Bearer ${userToken("u1")}`);
    expect(styleModel.getPublicStyles).toHaveBeenCalledWith({ isEnabled: true, isTrending: true });
    expect(list.body.map((s) => s.id)).toContain("s7");
  });
});

describe("IT-012 — GET /api/credit-packs (paywall)", () => {
  it("returns only enabled packs by default", async () => {
    creditPackModel.getCreditPacks.mockResolvedValue([{ id: "p1", credits: 10, isEnabled: true }]);
    const res = await request(app).get("/api/credit-packs");
    expect(res.status).toBe(200);
    expect(creditPackModel.getCreditPacks).toHaveBeenCalledWith({ isEnabled: true });
  });

  it("?all=true returns all packs (admin view)", async () => {
    creditPackModel.getCreditPacks.mockResolvedValue([]);
    await request(app).get("/api/credit-packs?all=true");
    expect(creditPackModel.getCreditPacks).toHaveBeenCalledWith({});
  });
});
