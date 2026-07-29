"use strict";

/**
 * SEC-8.1B-2 (step 3) — stable delivery URLs and the endpoint behind them.
 *
 * Two properties matter here and they are separate. The endpoint must
 * authorize by identity rather than by possession of a URL, and the responses
 * must stop handing storage URLs to clients. Either without the other is
 * useless: authorization on an endpoint nobody is pointed at changes nothing,
 * and pointing clients at an endpoint that does not check ownership is worse
 * than the public URLs it replaces.
 */

jest.mock("../../models/creationsModel", () => ({
  getCreationsByUser: jest.fn(),
  getCreationById: jest.fn(),
  addCreation: jest.fn(),
  deleteCreation: jest.fn(),
}));

const mockCreateSignedUrl = jest.fn();
jest.mock("../../config/supabase", () => ({
  storage: { from: jest.fn(() => ({ createSignedUrl: mockCreateSignedUrl })) },
}));

const creationsModel = require("../../models/creationsModel");
const supabase = require("../../config/supabase");
const {
  getCreations,
  getCreationImage,
  SIGNED_URL_TTL_SECONDS,
} = require("../creationsController");

const HOST = "https://proj.supabase.co/storage/v1/object/public";
const IMAGE_URL = `${HOST}/creations/original/abc.webp`;
const THUMB_URL = `${HOST}/creations/thumbs/abc.webp`;
const SIGNED = "https://proj.supabase.co/storage/v1/object/sign/creations/original/abc.webp?token=x";

const BACKEND = "https://api.styli.test";

function makeReqRes({ params = {}, user = { id: "u-1" } } = {}) {
  const req = { params, user, protocol: "https", get: () => "api.styli.test" };
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    redirect: jest.fn().mockReturnThis(),
  };
  return { req, res };
}

let originalBackendUrl;

beforeAll(() => {
  originalBackendUrl = process.env.BACKEND_URL;
  process.env.BACKEND_URL = BACKEND;
});

afterAll(() => {
  if (originalBackendUrl === undefined) delete process.env.BACKEND_URL;
  else process.env.BACKEND_URL = originalBackendUrl;
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
  mockCreateSignedUrl.mockResolvedValue({ data: { signedUrl: SIGNED }, error: null });
});

afterEach(() => console.error.mockRestore());

describe("SEC-8.1B-2 — GET /api/creations returns delivery URLs", () => {
  it("replaces storage URLs with stable per-creation addresses", async () => {
    creationsModel.getCreationsByUser.mockResolvedValue([
      { id: "c-1", imageUrl: IMAGE_URL, thumbnailUrl: THUMB_URL, styleName: "S" },
    ]);
    const { req, res } = makeReqRes();

    await getCreations(req, res);

    expect(res.json).toHaveBeenCalledWith([
      expect.objectContaining({
        id: "c-1",
        imageUrl: `${BACKEND}/api/creations/c-1/image`,
        thumbnailUrl: `${BACKEND}/api/creations/c-1/thumbnail`,
      }),
    ]);
  });

  it("never leaks a storage URL to the client", async () => {
    creationsModel.getCreationsByUser.mockResolvedValue([
      { id: "c-1", imageUrl: IMAGE_URL, thumbnailUrl: THUMB_URL },
    ]);
    const { req, res } = makeReqRes();

    await getCreations(req, res);

    expect(JSON.stringify(res.json.mock.calls[0][0])).not.toContain("/storage/v1/object/public/");
  });

  it("keeps a null thumbnail null", async () => {
    // The client reads null as "fall back to the original". Inventing an
    // address for an object that was never created would turn a graceful
    // fallback into a broken image.
    creationsModel.getCreationsByUser.mockResolvedValue([
      { id: "c-1", imageUrl: IMAGE_URL, thumbnailUrl: null },
    ]);
    const { req, res } = makeReqRes();

    await getCreations(req, res);

    expect(res.json.mock.calls[0][0][0].thumbnailUrl).toBeNull();
  });

  it("preserves every other field", async () => {
    creationsModel.getCreationsByUser.mockResolvedValue([
      { id: "c-1", imageUrl: IMAGE_URL, thumbnailUrl: THUMB_URL, styleName: "Vintage", styleId: "s-1" },
    ]);
    const { req, res } = makeReqRes();

    await getCreations(req, res);

    expect(res.json.mock.calls[0][0][0]).toMatchObject({ styleName: "Vintage", styleId: "s-1" });
  });
});

describe("SEC-8.1B-2 — the delivery endpoint", () => {
  it("redirects to a short-lived signed URL", async () => {
    creationsModel.getCreationById.mockResolvedValue({
      id: "c-1",
      imageUrl: IMAGE_URL,
      thumbnailUrl: THUMB_URL,
    });
    const { req, res } = makeReqRes({ params: { id: "c-1" } });

    await getCreationImage("image")(req, res);

    expect(supabase.storage.from).toHaveBeenCalledWith("creations");
    expect(mockCreateSignedUrl).toHaveBeenCalledWith("original/abc.webp", SIGNED_URL_TTL_SECONDS);
    expect(res.redirect).toHaveBeenCalledWith(302, SIGNED);
  });

  it("serves the thumbnail variant from thumbnail_url", async () => {
    creationsModel.getCreationById.mockResolvedValue({
      id: "c-1",
      imageUrl: IMAGE_URL,
      thumbnailUrl: THUMB_URL,
    });
    const { req, res } = makeReqRes({ params: { id: "c-1" } });

    await getCreationImage("thumbnail")(req, res);

    expect(mockCreateSignedUrl).toHaveBeenCalledWith("thumbs/abc.webp", SIGNED_URL_TTL_SECONDS);
  });

  it("falls back to the original when there is no thumbnail", async () => {
    creationsModel.getCreationById.mockResolvedValue({
      id: "c-1",
      imageUrl: IMAGE_URL,
      thumbnailUrl: null,
    });
    const { req, res } = makeReqRes({ params: { id: "c-1" } });

    await getCreationImage("thumbnail")(req, res);

    expect(mockCreateSignedUrl).toHaveBeenCalledWith("original/abc.webp", SIGNED_URL_TTL_SECONDS);
  });

  it("scopes the lookup to the requesting user", async () => {
    // This predicate IS the authorization: it is what replaces "whoever holds
    // the URL" with "whoever owns the row".
    creationsModel.getCreationById.mockResolvedValue(undefined);
    const { req, res } = makeReqRes({ params: { id: "c-1" }, user: { id: "u-9" } });

    await getCreationImage("image")(req, res);

    expect(creationsModel.getCreationById).toHaveBeenCalledWith("u-9", "c-1");
  });

  it("404s for someone else's creation, indistinguishably from a missing one", async () => {
    creationsModel.getCreationById.mockResolvedValue(undefined);
    const { req, res } = makeReqRes({ params: { id: "c-1" } });

    await getCreationImage("image")(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockCreateSignedUrl).not.toHaveBeenCalled();
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it("404s when the stored value never pointed at our storage", async () => {
    // A legacy local-only path migrated in by the client.
    creationsModel.getCreationById.mockResolvedValue({
      id: "c-1",
      imageUrl: "assets/images/sample.png",
      thumbnailUrl: null,
    });
    const { req, res } = makeReqRes({ params: { id: "c-1" } });

    await getCreationImage("image")(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockCreateSignedUrl).not.toHaveBeenCalled();
  });

  it("forbids caching the redirect itself", async () => {
    // The target expires; a cached 302 would keep sending clients at a dead
    // signature long after it stopped working.
    creationsModel.getCreationById.mockResolvedValue({
      id: "c-1",
      imageUrl: IMAGE_URL,
      thumbnailUrl: THUMB_URL,
    });
    const { req, res } = makeReqRes({ params: { id: "c-1" } });

    await getCreationImage("image")(req, res);

    expect(res.set).toHaveBeenCalledWith("Cache-Control", "private, no-store");
  });

  it("keeps the signature short-lived", async () => {
    expect(SIGNED_URL_TTL_SECONDS).toBeLessThanOrEqual(600);
  });

  it("502s when signing fails, without leaking the storage URL", async () => {
    creationsModel.getCreationById.mockResolvedValue({
      id: "c-1",
      imageUrl: IMAGE_URL,
      thumbnailUrl: THUMB_URL,
    });
    mockCreateSignedUrl.mockResolvedValue({ data: null, error: { message: "nope" } });
    const { req, res } = makeReqRes({ params: { id: "c-1" } });

    await getCreationImage("image")(req, res);

    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.redirect).not.toHaveBeenCalled();
    expect(JSON.stringify(res.json.mock.calls[0][0])).not.toContain("supabase.co");
  });

  it("works the same whether the bucket is public or private", async () => {
    // Nothing here reads bucket visibility: the signed URL is valid either
    // way, which is what makes the flip a config change rather than a deploy.
    creationsModel.getCreationById.mockResolvedValue({
      id: "c-1",
      imageUrl: `${HOST}/creations/original/abc.webp`,
      thumbnailUrl: null,
    });
    const { req, res } = makeReqRes({ params: { id: "c-1" } });

    await getCreationImage("image")(req, res);

    expect(res.redirect).toHaveBeenCalledWith(302, SIGNED);
  });
});

describe("SEC-8.1B-2 — failing safe when the origin cannot be resolved", () => {
  it("returns the storage URL rather than a relative path", async () => {
    // A relative URL would be worse than no change: the client dispatches on
    // scheme and would treat it as a bundled asset key, rendering nothing.
    // Falling back to the storage URL is the pre-migration behaviour, which
    // still works while the bucket is public.
    const saved = process.env.BACKEND_URL;
    delete process.env.BACKEND_URL;
    creationsModel.getCreationsByUser.mockResolvedValue([
      { id: "c-1", imageUrl: IMAGE_URL, thumbnailUrl: THUMB_URL },
    ]);
    // A request object with no `get`, i.e. no derivable host.
    const req = { params: {}, user: { id: "u-1" } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };

    await getCreations(req, res);

    process.env.BACKEND_URL = saved;

    const [rows] = res.json.mock.calls[0];
    expect(rows[0].imageUrl).toBe(IMAGE_URL);
    expect(rows[0].imageUrl.startsWith("http")).toBe(true);
  });
});
