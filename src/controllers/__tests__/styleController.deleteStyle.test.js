"use strict";

/**
 * SEC-8.4 — deleting a style erases its cover objects.
 *
 * Before this, `deleteStyle` removed the row and nothing else, so every deleted
 * style leaked its cover and cover thumbnail into `style-images` permanently.
 * That bucket is the one the reconciler does not sweep by default and cannot
 * safely sweep automatically, so those objects were unreachable in practice —
 * the leak was permanent, not merely delayed.
 */

jest.mock("../../models/styleModel", () => ({
  deleteStyle: jest.fn(),
}));
jest.mock("../../models/categoryModel", () => ({}));
jest.mock("../../services/recommendationService", () => ({
  invalidateCandidateCache: jest.fn(),
}));
jest.mock("../../services/autoTagService", () => ({}));
jest.mock("../../services/creationAssetCleanup", () => ({
  deleteStyleAssets: jest.fn(),
}));

const styleModel = require("../../models/styleModel");
const creationAssetCleanup = require("../../services/creationAssetCleanup");
const { deleteStyle } = require("../styleController");

const COVER = "https://x.supabase.co/storage/v1/object/public/style-images/original/c1.jpg";
const COVER_THUMB = "https://x.supabase.co/storage/v1/object/public/style-images/thumbs/c1.webp";

// deleteStyle uses RETURNING *, so the row arrives with raw column names.
const DELETED_ROW = {
  id: "s1",
  name: "Style 1",
  cover_image: COVER,
  cover_image_thumbnail: COVER_THUMB,
};

function makeReqRes(params = { id: "s1" }) {
  const req = { params, body: {}, query: {} };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn(), send: jest.fn() };
  return { req, res };
}

describe("SEC-8.4 — styleController.deleteStyle erases cover objects", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "error").mockImplementation(() => {});
    styleModel.deleteStyle.mockResolvedValue(DELETED_ROW);
    creationAssetCleanup.deleteStyleAssets.mockResolvedValue({ deleted: 2, skipped: [] });
  });

  afterEach(() => console.error.mockRestore());

  it("erases the cover and its thumbnail", async () => {
    const { req, res } = makeReqRes();

    await deleteStyle(req, res);

    expect(creationAssetCleanup.deleteStyleAssets).toHaveBeenCalledWith({
      styleId: "s1",
      urls: [COVER, COVER_THUMB],
    });
    expect(res.status).toHaveBeenCalledWith(204);
  });

  it("reads the snake_case columns RETURNING * actually produces", async () => {
    // The camelCase aliases exist on other model queries but not on this one;
    // reading style.coverImage here would silently erase nothing at all.
    const { req, res } = makeReqRes();

    await deleteStyle(req, res);

    const [{ urls }] = creationAssetCleanup.deleteStyleAssets.mock.calls[0];
    expect(urls).toEqual([COVER, COVER_THUMB]);
    expect(urls).not.toContain(undefined);
  });

  it("erases only after the row is gone", async () => {
    // With the row still present the style references its own cover, so the
    // referential guard would skip every delete and the leak would persist.
    const order = [];
    styleModel.deleteStyle.mockImplementation(async () => {
      order.push("row");
      return DELETED_ROW;
    });
    creationAssetCleanup.deleteStyleAssets.mockImplementation(async () => {
      order.push("objects");
      return { deleted: 2, skipped: [] };
    });
    const { req, res } = makeReqRes();

    await deleteStyle(req, res);

    expect(order).toEqual(["row", "objects"]);
  });

  it("does not erase anything when the style did not exist", async () => {
    styleModel.deleteStyle.mockResolvedValue(undefined);
    const { req, res } = makeReqRes({ id: "missing" });

    await deleteStyle(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(creationAssetCleanup.deleteStyleAssets).not.toHaveBeenCalled();
  });

  it("still returns 204 when erasure fails", async () => {
    // The row is already gone and the catalog has moved on; a storage failure
    // must not become a 500 the admin retries into a 404.
    creationAssetCleanup.deleteStyleAssets.mockRejectedValue(new Error("storage down"));
    const { req, res } = makeReqRes();

    await deleteStyle(req, res);

    expect(res.status).toHaveBeenCalledWith(204);
  });

  it("logs a structured failure line when erasure throws", async () => {
    creationAssetCleanup.deleteStyleAssets.mockRejectedValue(new Error("storage down"));
    const { req, res } = makeReqRes();

    await deleteStyle(req, res);

    const logged = console.error.mock.calls.map(([line]) => line).find((l) => typeof l === "string" && l.includes("style_asset_erasure"));
    expect(logged).toBeDefined();
    expect(JSON.parse(logged)).toMatchObject({
      event: "style_asset_erasure",
      outcome: "failed",
      styleId: "s1",
    });
  });

  it("still hands the deleted row to the audit middleware", async () => {
    // SEC-15.1 must not be collateral damage of adding cleanup here.
    const { req, res } = makeReqRes();

    await deleteStyle(req, res);

    expect(req.auditBefore).toEqual(DELETED_ROW);
  });
});
