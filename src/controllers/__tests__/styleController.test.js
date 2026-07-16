jest.mock("../../models/styleModel", () => ({
  getStyles: jest.fn(),
  getPublicStyles: jest.fn(),
  createStyle: jest.fn(),
  updateStyle: jest.fn(),
  updateStyleFlags: jest.fn(),
}));
jest.mock("../../models/categoryModel", () => ({
  getAllCategories: jest.fn(),
}));
jest.mock("../../services/recommendationService", () => ({
  isPersonalizationEnabled: jest.fn(),
  getPersonalizedRecommendations: jest.fn(),
  invalidateCandidateCache: jest.fn(),
}));
jest.mock("../../services/autoTagService", () => ({
  suggestTagsForStyle: jest.fn(),
}));

const styleModel = require("../../models/styleModel");
const categoryModel = require("../../models/categoryModel");
const recommendationService = require("../../services/recommendationService");
const autoTagService = require("../../services/autoTagService");
const { getStyles, createStyle, updateStyle, patchStyleFlags } = require("../styleController");

function makeReqRes({ query = {}, admin, user, body = {}, params = {} } = {}) {
  const req = { query, admin, user, body, params };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn(), send: jest.fn() };
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

  it("?trending=true adds isTrending to the filters, still scoped to enabled styles", async () => {
    const { req, res } = makeReqRes({});
    req.query = { trending: "true" };

    await getStyles(req, res);

    expect(styleModel.getPublicStyles).toHaveBeenCalledWith({ isEnabled: true, isTrending: true });
  });

  it("ignores trending param when it isn't exactly 'true'", async () => {
    const { req, res } = makeReqRes({});
    req.query = { trending: "yes" };

    await getStyles(req, res);

    expect(styleModel.getPublicStyles).toHaveBeenCalledWith({ isEnabled: true });
  });
});

describe("styleController.getStyles - ?recommended=true", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    console.error.mockRestore();
  });

  it("returns [] for an anonymous caller without ever checking personalization or ranking", async () => {
    const { req, res } = makeReqRes({ query: { recommended: "true" } });

    await getStyles(req, res);

    expect(res.json).toHaveBeenCalledWith([]);
    expect(recommendationService.isPersonalizationEnabled).not.toHaveBeenCalled();
    expect(recommendationService.getPersonalizedRecommendations).not.toHaveBeenCalled();
  });

  it("returns [] when the caller has personalization disabled, without ranking", async () => {
    recommendationService.isPersonalizationEnabled.mockResolvedValue(false);
    const { req, res } = makeReqRes({ query: { recommended: "true" }, user: { id: "u1" } });

    await getStyles(req, res);

    expect(recommendationService.isPersonalizationEnabled).toHaveBeenCalledWith("u1");
    expect(recommendationService.getPersonalizedRecommendations).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith([]);
  });

  it("delegates to recommendationService when logged in with personalization enabled", async () => {
    recommendationService.isPersonalizationEnabled.mockResolvedValue(true);
    recommendationService.getPersonalizedRecommendations.mockResolvedValue([{ id: "s1" }]);
    const { req, res } = makeReqRes({ query: { recommended: "true" }, user: { id: "u1" } });

    await getStyles(req, res);

    expect(recommendationService.getPersonalizedRecommendations).toHaveBeenCalledWith({ userId: "u1" });
    expect(res.json).toHaveBeenCalledWith([{ id: "s1" }]);
    expect(styleModel.getPublicStyles).not.toHaveBeenCalled();
  });
});

const BASE_BODY = {
  categoryId: "cat-1",
  name: "Cyberpunk mercenary",
  prompt: "a neon-lit cyberpunk scene",
};

describe("styleController.createStyle - auto-tag gating", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    categoryModel.getAllCategories.mockResolvedValue([{ id: "cat-1", name: "Fantasy" }]);
    styleModel.createStyle.mockResolvedValue({ id: "s1" });
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    console.error.mockRestore();
  });

  it("defaults to auto-tagging, ignoring any client-sent tagIds", async () => {
    autoTagService.suggestTagsForStyle.mockResolvedValue({ tagIds: ["t1", "t2"], status: "ok" });
    const { req, res } = makeReqRes({ body: { ...BASE_BODY, tagIds: ["client-sent-id"] } });

    await createStyle(req, res);

    expect(autoTagService.suggestTagsForStyle).toHaveBeenCalledWith({
      name: "Cyberpunk mercenary",
      prompt: "a neon-lit cyberpunk scene",
      categoryName: "Fantasy",
    });
    expect(styleModel.createStyle).toHaveBeenCalledWith(
      expect.objectContaining({ tagIds: ["t1", "t2"], tagsAutoAssigned: true })
    );
  });

  it("trusts client tagIds verbatim and skips classification when autoAssignTags is false", async () => {
    const { req, res } = makeReqRes({ body: { ...BASE_BODY, tagIds: ["manual-id"], autoAssignTags: false } });

    await createStyle(req, res);

    expect(autoTagService.suggestTagsForStyle).not.toHaveBeenCalled();
    expect(styleModel.createStyle).toHaveBeenCalledWith(
      expect.objectContaining({ tagIds: ["manual-id"], tagsAutoAssigned: false })
    );
  });

  it("stores an empty tag list (still auto-assigned) when classification errors, self-healing via later backfill", async () => {
    autoTagService.suggestTagsForStyle.mockResolvedValue({ tagIds: [], status: "error", errorMessage: "boom" });
    const { req, res } = makeReqRes({ body: BASE_BODY });

    await createStyle(req, res);

    expect(styleModel.createStyle).toHaveBeenCalledWith(
      expect.objectContaining({ tagIds: [], tagsAutoAssigned: true })
    );
  });
});

describe("styleController.updateStyle - auto-tag gating", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    categoryModel.getAllCategories.mockResolvedValue([{ id: "cat-1", name: "Fantasy" }]);
    styleModel.updateStyle.mockResolvedValue({ id: "s1" });
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    console.error.mockRestore();
  });

  it("skips the tag pipeline entirely when autoAssignTags is absent (e.g. a quick toggle call)", async () => {
    const { req, res } = makeReqRes({ params: { id: "s1" }, body: BASE_BODY });

    await updateStyle(req, res);

    expect(autoTagService.suggestTagsForStyle).not.toHaveBeenCalled();
    const callArg = styleModel.updateStyle.mock.calls[0][1];
    expect(callArg.tagIds).toBeUndefined();
    expect(callArg.tagsAutoAssigned).toBeUndefined();
  });

  it("re-classifies using this request's edited name/prompt/category when autoAssignTags is true", async () => {
    autoTagService.suggestTagsForStyle.mockResolvedValue({ tagIds: ["t9"], status: "ok" });
    const { req, res } = makeReqRes({
      params: { id: "s1" },
      body: { ...BASE_BODY, name: "Edited name", autoAssignTags: true },
    });

    await updateStyle(req, res);

    expect(autoTagService.suggestTagsForStyle).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Edited name" })
    );
    expect(styleModel.updateStyle).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ tagIds: ["t9"], tagsAutoAssigned: true })
    );
  });

  it("trusts client tagIds verbatim and sets tagsAutoAssigned false when autoAssignTags is false", async () => {
    const { req, res } = makeReqRes({
      params: { id: "s1" },
      body: { ...BASE_BODY, tagIds: ["manual-id"], autoAssignTags: false },
    });

    await updateStyle(req, res);

    expect(autoTagService.suggestTagsForStyle).not.toHaveBeenCalled();
    expect(styleModel.updateStyle).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ tagIds: ["manual-id"], tagsAutoAssigned: false })
    );
  });

  it("preserves existing tags (does not wipe them) when classification errors during an update", async () => {
    autoTagService.suggestTagsForStyle.mockResolvedValue({ tagIds: [], status: "error", errorMessage: "boom" });
    const { req, res } = makeReqRes({
      params: { id: "s1" },
      body: { ...BASE_BODY, autoAssignTags: true },
    });

    await updateStyle(req, res);

    const callArg = styleModel.updateStyle.mock.calls[0][1];
    expect(callArg.tagIds).toBeUndefined();
    expect(callArg.tagsAutoAssigned).toBeUndefined();
  });
});

describe("styleController.patchStyleFlags - quick toggle actions", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    styleModel.updateStyleFlags.mockResolvedValue({ id: "s1", isTrending: true, isEnabled: true });
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    console.error.mockRestore();
  });

  it("toggles isTrending without requiring the full style payload", async () => {
    const { req, res } = makeReqRes({ params: { id: "s1" }, body: { isTrending: true } });

    await patchStyleFlags(req, res);

    expect(styleModel.updateStyleFlags).toHaveBeenCalledWith("s1", {
      isTrending: true,
      isEnabled: undefined,
    });
    expect(res.json).toHaveBeenCalledWith({ id: "s1", isTrending: true, isEnabled: true });
    expect(recommendationService.invalidateCandidateCache).toHaveBeenCalledTimes(1);
  });

  it("toggles isEnabled without requiring the full style payload", async () => {
    const { req, res } = makeReqRes({ params: { id: "s1" }, body: { isEnabled: false } });

    await patchStyleFlags(req, res);

    expect(styleModel.updateStyleFlags).toHaveBeenCalledWith("s1", {
      isTrending: undefined,
      isEnabled: false,
    });
    expect(res.json).toHaveBeenCalled();
  });

  it("rejects an empty body with 400", async () => {
    const { req, res } = makeReqRes({ params: { id: "s1" }, body: {} });

    await patchStyleFlags(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(styleModel.updateStyleFlags).not.toHaveBeenCalled();
  });

  it("rejects non-boolean flag values with 400", async () => {
    const { req, res } = makeReqRes({ params: { id: "s1" }, body: { isTrending: "yes" } });

    await patchStyleFlags(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(styleModel.updateStyleFlags).not.toHaveBeenCalled();
  });

  it("returns 404 when the style does not exist", async () => {
    styleModel.updateStyleFlags.mockResolvedValue(undefined);
    const { req, res } = makeReqRes({ params: { id: "missing" }, body: { isEnabled: true } });

    await patchStyleFlags(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });
});
