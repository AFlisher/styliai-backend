/**
 * Per-style source image bounds on /api/generate (Feature).
 *
 * Styles carry min_images/max_images (default 1/1). The controller must
 * reject a wrong image count with 400 BEFORE any credit is charged, and
 * hand every accepted file to the generation service.
 */

require("../critical/setupEnv");

jest.mock("../../src/config/db", () => require("../critical/fakeDb"));
jest.mock("../../src/config/supabase", () => ({ storage: { from: () => ({}) } }));
jest.mock("../../src/services/generation/generationService", () => ({ generate: jest.fn() }));

const jwt = require("jsonwebtoken");
const request = require("supertest");
const app = require("../../src/app");
const fakeDb = require("../critical/fakeDb");
const generationService = require("../../src/services/generation/generationService");

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const token = (id) => jwt.sign({ sub: id, email: `${id}@x.com`, role: "authenticated" }, process.env.SUPABASE_JWT_SECRET, { expiresIn: "1h" });

function gen(userId, styleId, fileCount) {
  let req = request(app).post("/api/generate").set("Authorization", `Bearer ${token(userId)}`).field("styleId", styleId);
  for (let i = 0; i < fileCount; i++) {
    req = req.attach("file", PNG, { filename: `in${i}.png`, contentType: "image/png" });
  }
  return req;
}

beforeEach(() => {
  fakeDb.reset();
  generationService.generate.mockReset();
  generationService.generate.mockResolvedValue("http://cdn/out.png");
});

describe("image count enforcement on generate", () => {
  it("legacy style (no minImages/maxImages) still accepts exactly one image", async () => {
    fakeDb.seedUser({ id: "u1", balance: 10, email_verified: true });
    fakeDb.seedStyle({ id: "s1", creditCost: 2, isEnabled: true });

    const res = await gen("u1", "s1", 1);
    expect(res.status).toBe(200);
    expect(generationService.generate).toHaveBeenCalledTimes(1);
    const files = generationService.generate.mock.calls[0][0];
    expect(files).toHaveLength(1);
    expect(fakeDb.state.users.find((u) => u.id === "u1").balance).toBe(8);
  });

  it("legacy style rejects two images with 400 and no charge", async () => {
    fakeDb.seedUser({ id: "u2", balance: 10, email_verified: true });
    fakeDb.seedStyle({ id: "s2", creditCost: 2, isEnabled: true });

    const res = await gen("u2", "s2", 2);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/exactly 1/);
    expect(generationService.generate).not.toHaveBeenCalled();
    expect(fakeDb.state.users.find((u) => u.id === "u2").balance).toBe(10);
  });

  it("a two-image style rejects a single image with 400 and no charge", async () => {
    fakeDb.seedUser({ id: "u3", balance: 10, email_verified: true });
    fakeDb.seedStyle({ id: "s3", creditCost: 3, isEnabled: true, minImages: 2, maxImages: 2 });

    const res = await gen("u3", "s3", 1);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/exactly 2/);
    expect(generationService.generate).not.toHaveBeenCalled();
    expect(fakeDb.state.users.find((u) => u.id === "u3").balance).toBe(10);
  });

  it("a two-image style accepts two images and passes both files through", async () => {
    fakeDb.seedUser({ id: "u4", balance: 10, email_verified: true });
    fakeDb.seedStyle({ id: "s4", creditCost: 3, isEnabled: true, minImages: 2, maxImages: 2 });

    const res = await gen("u4", "s4", 2);
    expect(res.status).toBe(200);
    const files = generationService.generate.mock.calls[0][0];
    expect(files).toHaveLength(2);
    expect(Buffer.isBuffer(files[0].buffer)).toBe(true);
    expect(fakeDb.state.users.find((u) => u.id === "u4").balance).toBe(7);
  });

  it("a 1..3 style accepts one image and three, rejects four", async () => {
    fakeDb.seedUser({ id: "u5", balance: 10, email_verified: true });
    fakeDb.seedStyle({ id: "s5", creditCost: 1, isEnabled: true, minImages: 1, maxImages: 3 });

    expect((await gen("u5", "s5", 1)).status).toBe(200);
    expect((await gen("u5", "s5", 3)).status).toBe(200);
    const res = await gen("u5", "s5", 4);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/between 1 and 3/);
  });
});
