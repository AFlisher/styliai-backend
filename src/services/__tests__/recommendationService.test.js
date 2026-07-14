jest.mock("../../models/styleModel", () => ({
  getStyleById: jest.fn(),
  getEnabledStylesWithTags: jest.fn(),
  getPublicStylesByIds: jest.fn(),
}));
jest.mock("../../models/favoritesModel", () => ({
  getFavoriteStyleIds: jest.fn(),
}));
jest.mock("../../models/creationsModel", () => ({
  getCreationsByUser: jest.fn(),
}));
jest.mock("../../config/db", () => ({
  query: jest.fn(),
}));

const styleModel = require("../../models/styleModel");
const favoritesModel = require("../../models/favoritesModel");
const creationsModel = require("../../models/creationsModel");
const db = require("../../config/db");
const recommendationService = require("../recommendationService");

// Fixture candidate set: a small tag-overlap graph.
// - minimalist (tagA) and boho (tagB) are distinct clusters.
// - "vintage-hat" shares tagA with "minimalist-chair" and is also trending.
const CANDIDATES = [
  { id: "anchor", categoryId: "cat-1", isTrending: false, sortOrder: 0, createdAt: "2024-01-01T00:00:00Z", tagIds: ["tagA"] },
  { id: "same-tag", categoryId: "cat-2", isTrending: false, sortOrder: 1, createdAt: "2024-01-02T00:00:00Z", tagIds: ["tagA"] },
  { id: "same-category", categoryId: "cat-1", isTrending: false, sortOrder: 2, createdAt: "2024-01-03T00:00:00Z", tagIds: ["tagB"] },
  { id: "trending-unrelated", categoryId: "cat-3", isTrending: true, sortOrder: 3, createdAt: "2024-01-04T00:00:00Z", tagIds: ["tagC"] },
  { id: "no-signal", categoryId: "cat-3", isTrending: false, sortOrder: 4, createdAt: "2024-01-05T00:00:00Z", tagIds: ["tagC"] },
];

function byId(id) {
  return CANDIDATES.find((c) => c.id === id);
}

beforeEach(() => {
  jest.clearAllMocks();
  recommendationService.invalidateCandidateCache();
  styleModel.getEnabledStylesWithTags.mockResolvedValue(CANDIDATES);
  // Preserve requested order, mimicking the real getPublicStylesByIds contract
  // loosely enough for these tests (hydrateInScoreOrder re-sorts anyway).
  styleModel.getPublicStylesByIds.mockImplementation(async (ids) =>
    ids.map((id) => ({ id, name: id }))
  );
});

describe("getSimilarStyles", () => {
  it("returns null when the anchor style doesn't exist", async () => {
    styleModel.getStyleById.mockResolvedValue(undefined);

    const result = await recommendationService.getSimilarStyles({ styleId: "missing" });

    expect(result).toBeNull();
  });

  it("returns null when the anchor style is disabled", async () => {
    styleModel.getStyleById.mockResolvedValue({ ...byId("anchor"), isEnabled: false });

    const result = await recommendationService.getSimilarStyles({ styleId: "anchor" });

    expect(result).toBeNull();
  });

  it("excludes the anchor itself and ranks tag overlap above same-category above unrelated", async () => {
    styleModel.getStyleById.mockResolvedValue({ ...byId("anchor"), isEnabled: true });

    const result = await recommendationService.getSimilarStyles({ styleId: "anchor", limit: 10 });

    const ids = result.map((s) => s.id);
    expect(ids).not.toContain("anchor");
    // same-tag shares tagA (10 pts) > same-category shares categoryId (4 pts) > trending-unrelated (3 pts, no overlap)
    expect(ids.indexOf("same-tag")).toBeLessThan(ids.indexOf("same-category"));
    expect(ids.indexOf("same-category")).toBeLessThan(ids.indexOf("trending-unrelated"));
  });
});

describe("getPersonalizedRecommendations", () => {
  it("returns [] when the user has no favorites and no creations (cold start, no trending substitution)", async () => {
    favoritesModel.getFavoriteStyleIds.mockResolvedValue([]);
    creationsModel.getCreationsByUser.mockResolvedValue([]);

    const result = await recommendationService.getPersonalizedRecommendations({ userId: "u1" });

    expect(result).toEqual([]);
    // Cold start must short-circuit before ever touching the candidate set.
    expect(styleModel.getEnabledStylesWithTags).not.toHaveBeenCalled();
  });

  it("ranks candidates sharing tags with a favorited style above unrelated trending styles", async () => {
    favoritesModel.getFavoriteStyleIds.mockResolvedValue(["anchor"]);
    creationsModel.getCreationsByUser.mockResolvedValue([]);

    const result = await recommendationService.getPersonalizedRecommendations({ userId: "u1" });

    const ids = result.map((s) => s.id);
    expect(ids).not.toContain("anchor"); // already-favorited styles are excluded
    expect(ids).toContain("same-tag");
    expect(ids.indexOf("same-tag")).toBeLessThan(ids.indexOf("trending-unrelated"));
    expect(ids).not.toContain("no-signal"); // zero score is filtered out
  });

  it("counts creation history as a weaker signal than favorites but still surfaces overlap", async () => {
    favoritesModel.getFavoriteStyleIds.mockResolvedValue([]);
    creationsModel.getCreationsByUser.mockResolvedValue([{ styleId: "anchor" }]);

    const result = await recommendationService.getPersonalizedRecommendations({ userId: "u1" });

    const ids = result.map((s) => s.id);
    expect(ids).toContain("same-tag");
  });
});

describe("isPersonalizationEnabled", () => {
  it("defaults to true when the profile row is missing", async () => {
    db.query.mockResolvedValue({ rows: [] });

    const enabled = await recommendationService.isPersonalizationEnabled("u1");

    expect(enabled).toBe(true);
  });

  it("reflects a false personalization_enabled column", async () => {
    db.query.mockResolvedValue({ rows: [{ personalizationEnabled: false }] });

    const enabled = await recommendationService.isPersonalizationEnabled("u1");

    expect(enabled).toBe(false);
  });
});
