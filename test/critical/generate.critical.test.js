/**
 * Critical AI-generation suite (QA_TEST_PLAN.md):
 *   FT-011, FT-012, API-011, SEC-009, REG-002, REC-001
 *
 * The real wallet service runs against the in-memory DB, so credit
 * charge/refund correctness is asserted on actual balance + ledger state.
 * Only the paid AI provider (generationService) is faked.
 */

require("./setupEnv");

jest.mock("../../src/config/db", () => require("./fakeDb"));
jest.mock("../../src/config/supabase", () => ({ storage: { from: () => ({}) } }));
jest.mock("../../src/services/generation/generationService", () => ({ generate: jest.fn() }));

const jwt = require("jsonwebtoken");
const request = require("supertest");
const app = require("../../src/app");
const fakeDb = require("./fakeDb");
const generationService = require("../../src/services/generation/generationService");

// A genuine 1x1 PNG (not just the 8-byte signature) so the magic-byte content
// check (security fix L-2) positively identifies it as image/png.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

const userToken = (id) =>
  jwt.sign({ sub: id, email: `${id}@x.com`, role: "authenticated" }, process.env.SUPABASE_JWT_SECRET, { expiresIn: "1h" });

const ledgerFor = (id) => fakeDb.state.walletTransactions.filter((t) => t.userId === id);

beforeEach(() => {
  fakeDb.reset();
  generationService.generate.mockReset();
});

describe("FT-011 / REG-002 — successful generation charges exactly once", () => {
  it("deducts credits, returns the image, and records the ledger + creation counter", async () => {
    fakeDb.seedUser({ id: "g1", balance: 10, email_verified: true });
    fakeDb.seedStyle({ id: "s1", creditCost: 2, isEnabled: true });
    generationService.generate.mockResolvedValue({ imageUrl: "http://cdn/out.png", thumbnailUrl: "http://cdn/out-thumb.webp" });

    const res = await request(app)
      .post("/api/generate")
      .set("Authorization", `Bearer ${userToken("g1")}`)
      .field("styleId", "s1")
      .attach("file", PNG, { filename: "in.png", contentType: "image/png" });

    expect(res.status).toBe(200);
    expect(res.body.generatedImageUrl).toBe("http://cdn/out.png");

    const user = fakeDb.state.users.find((u) => u.id === "g1");
    expect(user.balance).toBe(8); // charged exactly once
    expect(user.generated_images).toBe(1);

    const gen = ledgerFor("g1").filter((t) => t.type === "generation");
    expect(gen).toHaveLength(1);
    expect(gen[0].amount).toBe(-2);
    expect(generationService.generate).toHaveBeenCalledTimes(1);
  });
});

describe("FT-012 — insufficient balance blocks before the provider is called", () => {
  it("returns 403 and never invokes the paid provider or deducts credits", async () => {
    fakeDb.seedUser({ id: "g2", balance: 1, email_verified: true });
    fakeDb.seedStyle({ id: "s2", creditCost: 5, isEnabled: true });

    const res = await request(app)
      .post("/api/generate")
      .set("Authorization", `Bearer ${userToken("g2")}`)
      .field("styleId", "s2")
      .attach("file", PNG, { filename: "in.png", contentType: "image/png" });

    expect(res.status).toBe(403);
    expect(generationService.generate).not.toHaveBeenCalled();
    const user = fakeDb.state.users.find((u) => u.id === "g2");
    expect(user.balance).toBe(1); // untouched
    expect(ledgerFor("g2")).toHaveLength(0);
  });
});

describe("API-011 — missing file is rejected", () => {
  it("returns 400 when no source image is attached", async () => {
    fakeDb.seedUser({ id: "g3", balance: 10, email_verified: true });
    fakeDb.seedStyle({ id: "s3", creditCost: 1, isEnabled: true });

    const res = await request(app)
      .post("/api/generate")
      .set("Authorization", `Bearer ${userToken("g3")}`)
      .field("styleId", "s3");

    expect(res.status).toBe(400);
    expect(generationService.generate).not.toHaveBeenCalled();
  });

  it("requires authentication (401 without a token)", async () => {
    const res = await request(app)
      .post("/api/generate")
      .field("styleId", "s3")
      .attach("file", PNG, { filename: "in.png", contentType: "image/png" });
    expect(res.status).toBe(401);
  });
});

describe("SEC-009 — generation upload enforces the image MIME allow-list", () => {
  it("rejects a non-image payload with 400 and no provider call", async () => {
    fakeDb.seedUser({ id: "g4", balance: 10, email_verified: true });
    fakeDb.seedStyle({ id: "s4", creditCost: 1, isEnabled: true });

    const res = await request(app)
      .post("/api/generate")
      .set("Authorization", `Bearer ${userToken("g4")}`)
      .field("styleId", "s4")
      .attach("file", Buffer.from("%PDF-1.4 fake"), { filename: "x.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/file type/i);
    expect(generationService.generate).not.toHaveBeenCalled();
    // No charge occurred for the rejected upload.
    const user = fakeDb.state.users.find((u) => u.id === "g4");
    expect(user.balance).toBe(10);
  });
});

describe("SEC-019 — generation upload verifies actual file content, not just the declared Content-Type (L-2)", () => {
  it("rejects a non-image payload relabeled with an allowed image Content-Type", async () => {
    fakeDb.seedUser({ id: "g6", balance: 10, email_verified: true });
    fakeDb.seedStyle({ id: "s6", creditCost: 1, isEnabled: true });

    const res = await request(app)
      .post("/api/generate")
      .set("Authorization", `Bearer ${userToken("g6")}`)
      .field("styleId", "s6")
      // Header claims image/png, but the bytes are not a PNG (or any image) -
      // the multer fileFilter's Content-Type check alone would let this
      // through; the magic-byte check must catch it.
      .attach("file", Buffer.from("this is definitely not an image, just text padding to be safe"), {
        filename: "malicious.png",
        contentType: "image/png",
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/file type/i);
    expect(generationService.generate).not.toHaveBeenCalled();
    const user = fakeDb.state.users.find((u) => u.id === "g6");
    expect(user.balance).toBe(10);
  });

  it("accepts a genuine image whose bytes match its declared Content-Type", async () => {
    fakeDb.seedUser({ id: "g7", balance: 10, email_verified: true });
    fakeDb.seedStyle({ id: "s7", creditCost: 1, isEnabled: true });
    generationService.generate.mockResolvedValue({ imageUrl: "http://cdn/out.png", thumbnailUrl: "http://cdn/out-thumb.webp" });

    const res = await request(app)
      .post("/api/generate")
      .set("Authorization", `Bearer ${userToken("g7")}`)
      .field("styleId", "s7")
      .attach("file", PNG, { filename: "in.png", contentType: "image/png" });

    expect(res.status).toBe(200);
    expect(generationService.generate).toHaveBeenCalledTimes(1);
  });
});

describe("REC-001 — provider failure after charge triggers a full refund", () => {
  it("refunds the credits so the user's net balance is unchanged, and returns an error", async () => {
    fakeDb.seedUser({ id: "g5", balance: 10, email_verified: true });
    fakeDb.seedStyle({ id: "s5", creditCost: 3, isEnabled: true });
    generationService.generate.mockRejectedValue(new Error("provider exploded"));

    const res = await request(app)
      .post("/api/generate")
      .set("Authorization", `Bearer ${userToken("g5")}`)
      .field("styleId", "s5")
      .attach("file", PNG, { filename: "in.png", contentType: "image/png" });

    expect(res.status).toBeGreaterThanOrEqual(500);

    const user = fakeDb.state.users.find((u) => u.id === "g5");
    expect(user.balance).toBe(10); // charged 3, refunded 3 -> net zero

    const ledger = ledgerFor("g5");
    expect(ledger.find((t) => t.type === "generation" && t.amount === -3)).toBeDefined();
    expect(ledger.find((t) => t.type === "refund" && t.amount === 3)).toBeDefined();
  });
});
