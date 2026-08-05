"use strict";

/**
 * Sprint 2 / B-3 — /api/purchases against the REAL app.
 *
 * Driven through supertest because the guarantees being asserted live in
 * middleware ordering: the auth gate, and the fact that a purchase is credited
 * to the bearer of the token and to nobody else. A handler-level test cannot
 * see either, and both are what stop this endpoint minting credits.
 */

process.env.SUPABASE_JWT_SECRET = "test-only-secret-never-used-in-production";
process.env.ADMIN_JWT_SECRET = "test-only-admin-secret-never-used-in-production";

jest.mock("../config/db", () => ({ query: jest.fn(), pool: { connect: jest.fn() } }));
jest.mock("../config/supabase", () => ({ storage: { from: jest.fn() } }));
jest.mock("../services/sessionService", () => require("../../test/mocks/activeSession"));
jest.mock("../services/purchases/purchaseService", () => ({
  redeemPurchase: jest.fn(),
  restorePurchases: jest.fn(),
  configuredPlatforms: jest.fn(() => ({ google: true, apple: false })),
}));

const request = require("supertest");
const jwt = require("jsonwebtoken");

const db = require("../config/db");
const app = require("../app");
const purchaseService = require("../services/purchases/purchaseService");
const { accountActionLimiter, userDataLimiter } = require("../middleware/rateLimiters");

const USER_ID = "11111111-2222-3333-4444-555555555555";
const SKU = "credits_pro_50";
const TOKEN = "opaque-purchase-token";

function accessToken(sub = USER_ID) {
  return jwt.sign(
    { sub, email: "u@example.com", aud: "authenticated", type: "access", token_version: 0 },
    process.env.SUPABASE_JWT_SECRET,
    { algorithm: "HS256", expiresIn: "5m" }
  );
}

function post(path, body, token = accessToken()) {
  const req = request(app).post(path);
  if (token) req.set("Authorization", `Bearer ${token}`);
  return req.send(body);
}

beforeEach(() => {
  jest.clearAllMocks();
  [accountActionLimiter, userDataLimiter].forEach((l) => {
    l.resetKey(USER_ID);
    l.resetKey("::ffff:127.0.0.1");
    l.resetKey("127.0.0.1");
  });
  db.query.mockResolvedValue({ rows: [], rowCount: 0 });
  purchaseService.redeemPurchase.mockResolvedValue({
    granted: true,
    credits: 50,
    balance: 70,
    productId: SKU,
  });
  purchaseService.restorePurchases.mockResolvedValue({
    creditsGranted: 0,
    balance: 20,
    results: [],
  });
  purchaseService.configuredPlatforms.mockReturnValue({ google: true, apple: false });
});

describe("authentication", () => {
  it("refuses an unauthenticated verify and never reaches the service", async () => {
    const res = await post("/api/purchases/verify", {
      platform: "google",
      productId: SKU,
      purchaseToken: TOKEN,
    }, null);

    expect(res.status).toBe(401);
    expect(purchaseService.redeemPurchase).not.toHaveBeenCalled();
  });

  it("refuses an unauthenticated restore", async () => {
    const res = await post("/api/purchases/restore", { platform: "google", purchases: [] }, null);

    expect(res.status).toBe(401);
    expect(purchaseService.restorePurchases).not.toHaveBeenCalled();
  });

  it("refuses a forged token", async () => {
    const forged = jwt.sign({ sub: USER_ID, aud: "authenticated", type: "access" }, "wrong-secret", {
      algorithm: "HS256",
      expiresIn: "5m",
    });

    const res = await post(
      "/api/purchases/verify",
      { platform: "google", productId: SKU, purchaseToken: TOKEN },
      forged
    );

    expect(res.status).toBe(401);
  });

  it("credits the bearer of the token, ignoring any userId in the body", async () => {
    const res = await post("/api/purchases/verify", {
      platform: "google",
      productId: SKU,
      purchaseToken: TOKEN,
      userId: "99999999-9999-9999-9999-999999999999",
    });

    expect(res.status).toBe(200);
    expect(purchaseService.redeemPurchase).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID })
    );
  });
});

describe("input validation", () => {
  it.each([
    ["missing platform", { productId: SKU, purchaseToken: TOKEN }],
    ["unsupported platform", { platform: "amazon", productId: SKU, purchaseToken: TOKEN }],
    ["missing productId", { platform: "google", purchaseToken: TOKEN }],
    ["missing purchaseToken", { platform: "google", productId: SKU }],
    ["empty purchaseToken", { platform: "google", productId: SKU, purchaseToken: "   " }],
    ["non-string token", { platform: "google", productId: SKU, purchaseToken: 12345 }],
  ])("rejects %s with 400 before verifying", async (_label, body) => {
    const res = await post("/api/purchases/verify", body);

    expect(res.status).toBe(400);
    expect(purchaseService.redeemPurchase).not.toHaveBeenCalled();
  });

  it("rejects an oversized purchase token", async () => {
    const res = await post("/api/purchases/verify", {
      platform: "google",
      productId: SKU,
      purchaseToken: "x".repeat(5000),
    });

    expect(res.status).toBe(400);
    expect(purchaseService.redeemPurchase).not.toHaveBeenCalled();
  });
});

describe("successful redemption", () => {
  it("returns the granted credits and the new balance", async () => {
    const res = await post("/api/purchases/verify", {
      platform: "google",
      productId: SKU,
      purchaseToken: TOKEN,
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, granted: true, credits: 50, balance: 70 });
  });

  it("answers 200 with granted:false on a replay, not an error", async () => {
    purchaseService.redeemPurchase.mockResolvedValue({
      granted: false,
      alreadyRedeemed: true,
      credits: 0,
      balance: 20,
    });

    const res = await post("/api/purchases/verify", {
      platform: "google",
      productId: SKU,
      purchaseToken: TOKEN,
    });

    // The client asked "credit this"; it is credited. Retrying must be safe.
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, granted: false, alreadyRedeemed: true });
  });
});

describe("refusals map to the right status", () => {
  it.each([
    ["not_configured", 503],
    ["verification_unavailable", 503],
    ["verifier_unauthorized", 503],
    ["grant_failed", 503],
    ["purchase_pending", 503],
    ["unknown_product", 422],
    ["purchase_not_found", 422],
    ["purchase_cancelled", 422],
    ["already_consumed", 422],
  ])("%s -> %i", async (reason, status) => {
    purchaseService.redeemPurchase.mockResolvedValue({ granted: false, reason });

    const res = await post("/api/purchases/verify", {
      platform: "google",
      productId: SKU,
      purchaseToken: TOKEN,
    });

    expect(res.status).toBe(status);
  });

  it("tells the buyer their purchase is safe when verification is unavailable", async () => {
    purchaseService.redeemPurchase.mockResolvedValue({
      granted: false,
      reason: "verification_unavailable",
    });

    const res = await post("/api/purchases/verify", {
      platform: "google",
      productId: SKU,
      purchaseToken: TOKEN,
    });

    expect(res.body.message).toMatch(/safe/i);
  });

  it("never leaks an internal error to the buyer", async () => {
    purchaseService.redeemPurchase.mockRejectedValue(
      new Error("connect ECONNREFUSED 10.0.0.4:5432")
    );

    const res = await post("/api/purchases/verify", {
      platform: "google",
      productId: SKU,
      purchaseToken: TOKEN,
    });

    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED|10\.0\.0\.4|5432/);
  });
});

describe("restore", () => {
  it("accepts an empty batch without calling the service", async () => {
    const res = await post("/api/purchases/restore", { platform: "google", purchases: [] });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, creditsGranted: 0 });
    expect(purchaseService.restorePurchases).not.toHaveBeenCalled();
  });

  it("rejects a non-array purchases field", async () => {
    const res = await post("/api/purchases/restore", { platform: "google", purchases: "nope" });
    expect(res.status).toBe(400);
  });

  it("rejects an oversized batch", async () => {
    const purchases = Array.from({ length: 51 }, (_, i) => ({
      productId: SKU,
      purchaseToken: `tok-${i}`,
    }));

    const res = await post("/api/purchases/restore", { platform: "google", purchases });

    expect(res.status).toBe(400);
    expect(purchaseService.restorePurchases).not.toHaveBeenCalled();
  });

  it("validates every item before redeeming any", async () => {
    const res = await post("/api/purchases/restore", {
      platform: "google",
      purchases: [
        { productId: SKU, purchaseToken: "good" },
        { productId: SKU }, // malformed tail
      ],
    });

    expect(res.status).toBe(400);
    expect(purchaseService.restorePurchases).not.toHaveBeenCalled();
  });

  it("returns per-item results", async () => {
    purchaseService.restorePurchases.mockResolvedValue({
      creditsGranted: 50,
      balance: 70,
      results: [
        { productId: SKU, granted: true, alreadyRedeemed: false, reason: null },
        { productId: SKU, granted: false, alreadyRedeemed: true, reason: null },
      ],
    });

    const res = await post("/api/purchases/restore", {
      platform: "google",
      purchases: [
        { productId: SKU, purchaseToken: "a" },
        { productId: SKU, purchaseToken: "b" },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.creditsGranted).toBe(50);
    expect(res.body.results).toHaveLength(2);
  });
});

describe("configuration surface", () => {
  it("reports which platforms can be verified", async () => {
    const res = await request(app)
      .get("/api/purchases/config")
      .set("Authorization", `Bearer ${accessToken()}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ platforms: { google: true, apple: false } });
  });

  it("is not readable anonymously", async () => {
    const res = await request(app).get("/api/purchases/config");
    expect(res.status).toBe(401);
  });
});
