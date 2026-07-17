/**
 * min_images/max_images validation and pass-through on the admin style
 * create/update endpoints.
 */

jest.mock("../../models/styleModel", () => ({
  createStyle: jest.fn(),
  updateStyle: jest.fn(),
}));
jest.mock("../../models/categoryModel", () => ({
  getAllCategories: jest.fn().mockResolvedValue([]),
}));
jest.mock("../../services/recommendationService", () => ({
  invalidateCandidateCache: jest.fn(),
}));
jest.mock("../../services/autoTagService", () => ({
  suggestTagsForStyle: jest.fn().mockResolvedValue({ status: "ok", tagIds: [] }),
}));

const styleModel = require("../../models/styleModel");
const { createStyle, updateStyle } = require("../styleController");

function makeReqRes(body) {
  const req = { body, params: { id: "s1" } };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  return { req, res };
}

const BASE = { categoryId: "c1", name: "Style", prompt: "a prompt", autoAssignTags: false };

beforeEach(() => {
  jest.clearAllMocks();
  styleModel.createStyle.mockResolvedValue({ id: "s1" });
  styleModel.updateStyle.mockResolvedValue({ id: "s1" });
});

describe("createStyle image counts", () => {
  it("defaults to 1/1 when the keys are absent (older dashboard payloads)", async () => {
    const { req, res } = makeReqRes({ ...BASE });
    await createStyle(req, res);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(styleModel.createStyle).toHaveBeenCalledWith(
      expect.objectContaining({ minImages: 1, maxImages: 1 })
    );
  });

  it("persists provided bounds", async () => {
    const { req, res } = makeReqRes({ ...BASE, minImages: 2, maxImages: 4 });
    await createStyle(req, res);
    expect(styleModel.createStyle).toHaveBeenCalledWith(
      expect.objectContaining({ minImages: 2, maxImages: 4 })
    );
  });

  it.each([
    [{ minImages: 0, maxImages: 1 }, /at least 1/],
    [{ minImages: 3, maxImages: 2 }, /at least the minimum/],
    [{ minImages: 1, maxImages: 6 }, /cannot exceed 5/],
    [{ minImages: 1.5, maxImages: 2 }, /whole number/],
  ])("rejects %j with 400", async (counts, msg) => {
    const { req, res } = makeReqRes({ ...BASE, ...counts });
    await createStyle(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ message: expect.stringMatching(msg) });
    expect(styleModel.createStyle).not.toHaveBeenCalled();
  });
});

describe("updateStyle image counts", () => {
  it("validates and passes bounds through", async () => {
    const { req, res } = makeReqRes({ ...BASE, minImages: 1, maxImages: 3 });
    await updateStyle(req, res);
    expect(styleModel.updateStyle).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ minImages: 1, maxImages: 3 })
    );
  });

  it("rejects max < min with 400", async () => {
    const { req, res } = makeReqRes({ ...BASE, minImages: 4, maxImages: 2 });
    await updateStyle(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(styleModel.updateStyle).not.toHaveBeenCalled();
  });
});
