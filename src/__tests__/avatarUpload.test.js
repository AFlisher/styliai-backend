"use strict";

/**
 * R-2 phase 1 — POST /api/profile/avatar, against the REAL app.
 *
 * Driven through supertest rather than by calling the handler, because most of
 * what is being asserted lives in middleware: the auth gate, the body ceiling,
 * and the magic-byte check all sit in front of the controller, and a change
 * that drops any of them from the route would not be visible to a unit test of
 * the handler.
 *
 * The premise being fixed, measured against production before this existed:
 * identical PNG bytes were ACCEPTED by the bucket when labelled `image/jpeg`
 * and REJECTED when labelled `image/png` — proof that the only pre-existing
 * "validation" read the label rather than the file. HTML, an SVG carrying a
 * script, and a JPEG with an appended `<script>` were all accepted as
 * `image/jpeg`, and a 10000x10000 JPEG (572 KiB on the wire, ~286 MiB decoded)
 * was accepted too.
 */

process.env.SUPABASE_JWT_SECRET = "test-only-secret-never-used-in-production";

const mockUpload = jest.fn();
const mockGetPublicUrl = jest.fn();

jest.mock("../config/supabase", () => ({
  storage: {
    from: jest.fn(() => ({
      upload: mockUpload,
      getPublicUrl: mockGetPublicUrl,
    })),
  },
}));

jest.mock("../config/db", () => ({ query: jest.fn(), pool: { connect: jest.fn() } }));
// Phase 6: the auth middlewares now read session state per request. See the
// helper for why this is mocked rather than queued into each db.query stub.
jest.mock("../services/sessionService", () => require("../../test/mocks/activeSession"));

const request = require("supertest");
const jwt = require("jsonwebtoken");
const sharp = require("sharp");
const db = require("../config/db");
const supabase = require("../config/supabase");
const app = require("../app");
const { avatarUploadLimiter } = require("../middleware/rateLimiters");
const imageMetadataSanitizer = require("../utils/imageMetadataSanitizer");
const { carriesMetadata } = imageMetadataSanitizer;

const USER_ID = "f60f71b5-be64-43d4-b747-e2dadd8787f7";
const PROJECT = "https://proj.supabase.co";

function userToken(overrides = {}) {
  return jwt.sign(
    { sub: USER_ID, email: "u@example.com", aud: "authenticated", type: "access", ...overrides },
    process.env.SUPABASE_JWT_SECRET,
    { algorithm: "HS256", expiresIn: "5m" }
  );
}

function post(bytes, { filename = "avatar.jpg", contentType = "image/jpeg", token = userToken() } = {}) {
  const req = request(app).post("/api/profile/avatar");
  if (token) req.set("Authorization", `Bearer ${token}`);
  return req.attach("avatar", bytes, { filename, contentType });
}

// ── fixtures ────────────────────────────────────────────────────────────────

/**
 * A 3-frame animated GIF, built by hand because sharp can only write an
 * animated image from an animated source. Same construction as the SEC-8.3
 * suite's fixture.
 */
function animatedGif() {
  const base = Buffer.from(
    "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
    "base64"
  );
  const header = base.subarray(0, 19);
  const frame = base.subarray(19, base.length - 1);
  const otherFrame = Buffer.from(frame);
  otherFrame[otherFrame.length - 2] = 0x4c;
  const netscapeLoop = Buffer.from("21ff0b4e45545343415045322e300301000000", "hex");

  return Buffer.concat([header, netscapeLoop, frame, otherFrame, frame, Buffer.from([0x3b])]);
}

let jpeg, png, webp, gif, animatedWebp, jpegWithExif, oversized, polyglot;

beforeAll(async () => {
  const base = () => sharp({ create: { width: 64, height: 64, channels: 3, background: "#3366aa" } });
  jpeg = await base().jpeg().toBuffer();
  png = await base().png().toBuffer();
  webp = await base().webp().toBuffer();
  gif = await base().gif().toBuffer();

  // sharp can only write an animated image from an animated source, so this
  // bootstraps from the same hand-built GIF used by the SEC-8.3 suite.
  animatedWebp = await sharp(animatedGif(), { animated: true }).webp().toBuffer();

  // A real EXIF block, so the sanitization assertion is not vacuous.
  jpegWithExif = await base()
    .withExif({ IFD0: { Copyright: "test", Make: "TestPhone" } })
    .jpeg()
    .toBuffer();

  // Comfortably inside the 10 MiB body limit, far outside the pixel ceiling.
  oversized = await sharp({ create: { width: 5000, height: 5000, channels: 3, background: "#000" } })
    .jpeg({ quality: 1 })
    .toBuffer();

  polyglot = Buffer.concat([jpeg, Buffer.from("\n<script>alert(1)</script>")]);
});

beforeEach(() => {
  jest.clearAllMocks();
  // Phase 6 gave this endpoint its own limiter (10 per 15 minutes, keyed on the
  // user). That budget is sized for a human changing their profile photo, not
  // for a suite that uploads ~30 times, so each test starts from a clean one.
  // Reset rather than raised: the limit is the production value and this suite
  // must keep exercising the real middleware chain.
  avatarUploadLimiter.resetKey(USER_ID);
  jest.spyOn(console, "error").mockImplementation(() => {});
  mockUpload.mockResolvedValue({ error: null });
  mockGetPublicUrl.mockImplementation((path) => ({
    data: { publicUrl: `${PROJECT}/storage/v1/object/public/avatars/${path}` },
  }));
  db.query.mockResolvedValue({ rows: [], rowCount: 1 });
});

afterEach(() => jest.restoreAllMocks());

/** The bytes handed to storage, i.e. what actually gets stored. */
function storedBuffer() {
  return mockUpload.mock.calls[0][1];
}

// ── authentication ──────────────────────────────────────────────────────────
describe("authentication is required", () => {
  it("401s with no Authorization header, without buffering the body", async () => {
    const res = await post(jpeg, { token: null });

    expect(res.status).toBe(401);
    expect(mockUpload).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });

  it("401s on a token signed with the wrong secret", async () => {
    const forged = jwt.sign({ sub: USER_ID, aud: "authenticated" }, "not-the-secret", {
      algorithm: "HS256",
    });

    const res = await post(jpeg, { token: forged });

    expect(res.status).toBe(401);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it("401s on a refresh token presented as a bearer (SEC-1.1)", async () => {
    const refresh = jwt.sign(
      { sub: USER_ID, aud: "authenticated", type: "refresh" },
      process.env.SUPABASE_JWT_SECRET,
      { algorithm: "HS256", expiresIn: "5m" }
    );

    const res = await post(jpeg, { token: refresh });

    expect(res.status).toBe(401);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it("stores under the authenticated user's id, never a client-supplied one", async () => {
    // The object name is the authorization boundary for avatars: it is the one
    // storage object an attacker could name deliberately.
    await post(jpeg, { filename: "../../someone-else.jpg" });

    expect(mockUpload.mock.calls[0][0]).toBe(`${USER_ID}.jpg`);
  });
});

// ── valid images ────────────────────────────────────────────────────────────
describe("valid images are accepted", () => {
  it("accepts a JPEG and returns the stored URL", async () => {
    const res = await post(jpeg);

    expect(res.status).toBe(200);
    expect(res.body.avatarUrl).toContain(`/avatars/${USER_ID}.jpg`);
  });

  it("accepts a PNG and normalises it to JPEG", async () => {
    // The storage scheme is <uid>.jpg served as image/jpeg, so a PNG has to
    // become a JPEG - and the declared type is what the bucket allow-list
    // checks, so it must be true rather than merely claimed.
    const res = await post(png, { filename: "avatar.png", contentType: "image/png" });

    expect(res.status).toBe(200);
    expect((await sharp(storedBuffer()).metadata()).format).toBe("jpeg");
    expect(mockUpload.mock.calls[0][2]).toMatchObject({ contentType: "image/jpeg", upsert: true });
  });

  it("accepts a WebP and normalises it to JPEG", async () => {
    const res = await post(webp, { filename: "a.webp", contentType: "image/webp" });

    expect(res.status).toBe(200);
    expect((await sharp(storedBuffer()).metadata()).format).toBe("jpeg");
  });

  it("preserves the image's dimensions", async () => {
    await post(png, { contentType: "image/png" });

    const meta = await sharp(storedBuffer()).metadata();
    expect([meta.width, meta.height]).toEqual([64, 64]);
  });
});

// ── the file decides, not the labels ────────────────────────────────────────
describe("validation reads the bytes, not the labels", () => {
  it("accepts a PNG whose extension claims JPEG", async () => {
    // Spoofed extension: the filename is not consulted at all.
    const res = await post(png, { filename: "definitely-a.jpg", contentType: "image/png" });

    expect(res.status).toBe(200);
  });

  it("accepts a PNG whose Content-Type claims JPEG", async () => {
    // Spoofed Content-Type, the exact case the bucket allow-list gets wrong.
    // It is accepted because it IS an image - the label is simply irrelevant.
    const res = await post(png, { filename: "a.png", contentType: "image/jpeg" });

    expect(res.status).toBe(200);
    expect((await sharp(storedBuffer()).metadata()).format).toBe("jpeg");
  });

  it("rejects HTML disguised as a JPEG, at the magic-byte layer", async () => {
    const html = Buffer.from("<html><script>alert(document.domain)</script></html>");

    const res = await post(html, { filename: "avatar.jpg", contentType: "image/jpeg" });

    expect(res.status).toBe(400);
    // Asserting WHICH layer refused it, not merely that something did. Without
    // this the test passes even with magic-byte verification disabled, because
    // sharp would fail to decode it a moment later - so it would silently stop
    // proving the signature check is still wired in.
    expect(res.body.message).toMatch(/Invalid file type/i);
    expect(mockUpload).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });

  it("rejects an SVG carrying a script, at the magic-byte layer", async () => {
    // SVG is the case that makes this layer worth keeping: it is a real image
    // format to a human, has no raster signature, and is a script container.
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

    const res = await post(svg, { filename: "avatar.jpg", contentType: "image/jpeg" });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Invalid file type/i);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it("rejects a GIF, which is a real image but not an avatar", async () => {
    // Passes the magic-byte filter; refused on the decoded format.
    const res = await post(gif, { filename: "a.gif", contentType: "image/gif" });

    expect(res.status).toBe(400);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it("rejects a malformed image whose signature is valid", async () => {
    // Header says JPEG, body is truncated garbage - the case a magic-byte
    // check alone cannot catch, which is why the decode is the real gate.
    const truncated = Buffer.concat([jpeg.subarray(0, 20), Buffer.alloc(200, 0xab)]);

    const res = await post(truncated);

    expect(res.status).toBe(400);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it("rejects an empty file", async () => {
    const res = await post(Buffer.alloc(0));

    expect(res.status).toBe(400);
    expect(mockUpload).not.toHaveBeenCalled();
  });
});

// ── polyglot ────────────────────────────────────────────────────────────────
describe("polyglot payloads", () => {
  it("strips data appended after a valid JPEG rather than storing it", async () => {
    // The subtle one. A JPEG with bytes appended past its end marker decodes
    // fine and carries no metadata, so a conditional "strip only if dirty"
    // pass would return it byte-identical with the payload intact. The
    // unconditional re-encode emits only what was decoded.
    const res = await post(polyglot);

    expect(res.status).toBe(200);
    expect(storedBuffer().includes("<script>")).toBe(false);
    expect(storedBuffer().length).toBeLessThan(polyglot.length);
  });

  it("stores a decodable image, not the original bytes", async () => {
    await post(polyglot);

    const meta = await sharp(storedBuffer()).metadata();
    expect(meta.format).toBe("jpeg");
    expect(storedBuffer().equals(polyglot)).toBe(false);
  });
});

// ── size and dimensions ─────────────────────────────────────────────────────
describe("size and dimension ceilings", () => {
  it("rejects a body over 10 MiB", async () => {
    const huge = Buffer.alloc(11 * 1024 * 1024, 0x41);

    const res = await post(huge);

    expect(res.status).toBe(400);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it("rejects excessive dimensions even when the file is small", async () => {
    // 5000x5000 at quality 1 is a tiny file and a large decode. Refused on
    // the header, before any pixels are decoded.
    expect(oversized.length).toBeLessThan(10 * 1024 * 1024);

    const res = await post(oversized);

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/too large/i);
    expect(mockUpload).not.toHaveBeenCalled();
  });
});

// ── animated ────────────────────────────────────────────────────────────────
describe("animated and multi-page images", () => {
  it("rejects an animated WebP", async () => {
    const meta = await sharp(animatedWebp).metadata();
    expect(meta.pages).toBeGreaterThan(1); // the fixture is genuinely multi-page

    const res = await post(animatedWebp, { filename: "a.webp", contentType: "image/webp" });

    expect(res.status).toBe(400);
    expect(mockUpload).not.toHaveBeenCalled();
  });
});

// ── sanitization ────────────────────────────────────────────────────────────
describe("metadata sanitization (SEC-8.3)", () => {
  it("stores no EXIF for an image that arrived carrying it", async () => {
    expect(carriesMetadata(await sharp(jpegWithExif).metadata())).toBe(true); // fixture is dirty

    const res = await post(jpegWithExif);

    expect(res.status).toBe(200);
    expect(carriesMetadata(await sharp(storedBuffer()).metadata())).toBe(false);
  });

  it("does not leak the original EXIF bytes into what is stored", async () => {
    await post(jpegWithExif);

    expect(storedBuffer().includes("TestPhone")).toBe(false);
  });

  it("stores exactly what the SEC-8.3 sanitizer returned", async () => {
    // Worth being precise about what this proves, because the two assertions
    // above pass without the sanitizer at all: the unconditional re-encode
    // already emits no EXIF, since sharp does not carry metadata across unless
    // asked. So the sanitizer is a backstop, not the active stripper - it is
    // what catches a future `.keepExif()`/`.withMetadata()` creeping into the
    // encode. A backstop that is not wired in is worth nothing, so this pins
    // that it sits in the data path rather than beside it.
    const marker = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#ff0000" } })
      .jpeg()
      .toBuffer();
    const spy = jest
      .spyOn(imageMetadataSanitizer, "sanitizeImageBuffer")
      .mockResolvedValue({ buffer: marker, format: "jpeg", stripped: true });

    await post(jpeg);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(storedBuffer().equals(marker)).toBe(true);
  });
});

// ── storage and database ────────────────────────────────────────────────────
describe("storage and profile update", () => {
  it("uploads to the avatars bucket through the service-role client", async () => {
    await post(jpeg);

    expect(supabase.storage.from).toHaveBeenCalledWith("avatars");
    expect(mockUpload).toHaveBeenCalledTimes(1);
  });

  it("upserts under <userId>.jpg as image/jpeg", async () => {
    await post(jpeg);

    const [path, , options] = mockUpload.mock.calls[0];
    expect(path).toBe(`${USER_ID}.jpg`);
    expect(options).toMatchObject({ contentType: "image/jpeg", upsert: true });
  });

  it("updates profiles.avatar_url for that user, and nothing else", async () => {
    await post(jpeg);

    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE public\.profiles/i);
    expect(sql).toMatch(/SET avatar_url = \$1/i);
    expect(sql).toMatch(/WHERE id = \$2/i);
    expect(params[1]).toBe(USER_ID);
  });

  it("records a cache-busted URL, which SEC-8.4B keeps matchable", async () => {
    const res = await post(jpeg);

    expect(res.body.avatarUrl).toMatch(/\?v=\d+$/);
    expect(db.query.mock.calls[0][1][0]).toBe(res.body.avatarUrl);
  });

  it("does not touch users.avatar_url", async () => {
    // Deliberately out of scope for phase 1: that column holds the Google
    // OAuth picture for most accounts.
    await post(jpeg);

    expect(db.query.mock.calls[0][0]).not.toMatch(/public\.users/i);
  });

  it("500s and writes no profile row when storage fails", async () => {
    mockUpload.mockResolvedValue({ error: { message: "storage exploded" } });

    const res = await post(jpeg);

    expect(res.status).toBe(500);
    expect(db.query).not.toHaveBeenCalled();
    expect(JSON.stringify(res.body)).not.toContain("storage exploded");
  });

  it("reports a rejected file as 400, not 500", async () => {
    const res = await post(Buffer.from("<html></html>"));

    expect(res.status).toBe(400);
  });
});
