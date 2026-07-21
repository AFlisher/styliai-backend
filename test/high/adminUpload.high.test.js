/**
 * Admin image upload content-validation suite (security fix L-2).
 * Mirrors the /api/generate magic-byte check for the admin-only style-image
 * upload endpoint, which shares the same Content-Type-only vulnerability
 * pattern (src/middleware/adminImageUpload.js).
 */

require("../critical/setupEnv");

jest.mock("../../src/config/db", () => require("../critical/fakeDb"));
jest.mock("../../src/config/supabase", () => ({ storage: { from: () => ({}) } }));
jest.mock("../../src/services/imageStorageService", () => ({
  uploadOriginalWithThumbnail: jest.fn().mockResolvedValue({
    url: "http://cdn/style.png",
    thumbnailUrl: "http://cdn/style-thumb.webp",
  }),
}));

const jwt = require("jsonwebtoken");
const request = require("supertest");
const app = require("../../src/app");
const imageStorageService = require("../../src/services/imageStorageService");

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

const adminToken = () =>
  jwt.sign({ sub: "admin-1", email: "a@x.com", role: "admin" }, process.env.ADMIN_JWT_SECRET, { expiresIn: "2h" });

beforeEach(() => imageStorageService.uploadOriginalWithThumbnail.mockClear());

describe("POST /api/upload content validation", () => {
  it("rejects a non-image payload relabeled with an allowed image Content-Type", async () => {
    const res = await request(app)
      .post("/api/upload")
      .set("Authorization", `Bearer ${adminToken()}`)
      .attach("file", Buffer.from("this is definitely not an image"), {
        filename: "malicious.png",
        contentType: "image/png",
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/file type/i);
    expect(imageStorageService.uploadOriginalWithThumbnail).not.toHaveBeenCalled();
  });

  it("accepts a genuine image whose bytes match its declared Content-Type", async () => {
    const res = await request(app)
      .post("/api/upload")
      .set("Authorization", `Bearer ${adminToken()}`)
      .attach("file", PNG, { filename: "style.png", contentType: "image/png" });

    expect(res.status).toBe(200);
    expect(imageStorageService.uploadOriginalWithThumbnail).toHaveBeenCalledTimes(1);
  });
});
