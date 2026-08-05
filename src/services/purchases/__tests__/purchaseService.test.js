"use strict";

/**
 * Sprint 2 / B-3 — purchaseService.
 *
 * The properties here are the ones that decide whether the credit economy can
 * be minted for free. Each is asserted against the statements issued and the
 * arguments passed, not against the response body, because a service that
 * grants the right number of credits for the wrong reason still passes a
 * response-shaped test.
 */

jest.mock("../../../config/db", () => ({ query: jest.fn(), pool: { connect: jest.fn() } }));
jest.mock("../../wallet/walletService", () => ({
  addBalance: jest.fn(),
  getBalance: jest.fn(),
}));
jest.mock("../googlePlayVerifier", () => ({
  verifyPurchase: jest.fn(),
  acknowledgePurchase: jest.fn(),
  isConfigured: jest.fn(() => true),
}));
jest.mock("../appleVerifier", () => ({
  verifyPurchase: jest.fn(),
  acknowledgePurchase: jest.fn(),
  isConfigured: jest.fn(() => false),
}));

const db = require("../../../config/db");
const walletService = require("../../wallet/walletService");
const googlePlayVerifier = require("../googlePlayVerifier");
const appleVerifier = require("../appleVerifier");
const purchaseService = require("../purchaseService");

const USER_ID = "11111111-2222-3333-4444-555555555555";
const TOKEN = "opaque-purchase-token";
const SKU = "credits_pro_50";

/** db.query router: packs resolve, claims succeed, everything else is empty. */
function mockDb({ packFound = true, claimWins = true } = {}) {
  db.query.mockImplementation(async (text) => {
    if (/FROM credit_packs/i.test(text)) {
      return packFound
        ? { rows: [{ id: "pack-1", name: "Pro Pack", credits: 50, productId: SKU }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (/INSERT INTO processed_purchases/i.test(text)) {
      return { rows: [], rowCount: claimWins ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  });
}

function statementsMatching(re) {
  return db.query.mock.calls.filter(([text]) => re.test(String(text)));
}

beforeEach(() => {
  jest.clearAllMocks();
  walletService.addBalance.mockResolvedValue(70);
  walletService.getBalance.mockResolvedValue(20);
  googlePlayVerifier.acknowledgePurchase.mockResolvedValue({ ok: true });
  googlePlayVerifier.verifyPurchase.mockResolvedValue({
    ok: true,
    productId: SKU,
    orderId: "GPA.1234",
    acknowledged: false,
  });
});

describe("the client is not trusted", () => {
  it("grants the credits of the product GOOGLE reported, not the one the client sent", async () => {
    mockDb();
    // Client claims the 100-credit pack; Google says it was the 50-credit one.
    googlePlayVerifier.verifyPurchase.mockResolvedValue({
      ok: true,
      productId: SKU,
      orderId: null,
      acknowledged: false,
    });

    const result = await purchaseService.redeemPurchase({
      userId: USER_ID,
      platform: "google",
      productId: "credits_max_100",
      purchaseToken: TOKEN,
    });

    // The pack lookup uses the verified id.
    const lookup = statementsMatching(/FROM credit_packs/i)[0];
    expect(lookup[1]).toEqual([SKU]);
    expect(result.credits).toBe(50);
  });

  it("never derives the credit amount from the request", async () => {
    mockDb();

    await purchaseService.redeemPurchase({
      userId: USER_ID,
      platform: "google",
      productId: SKU,
      purchaseToken: TOKEN,
      // A hostile extra field; must be ignored entirely.
      credits: 99999,
    });

    expect(walletService.addBalance).toHaveBeenCalledWith(
      USER_ID,
      50,
      "purchase",
      expect.stringContaining("Pro Pack")
    );
  });

  it("refuses an unsupported platform without verifying anything", async () => {
    mockDb();

    const result = await purchaseService.redeemPurchase({
      userId: USER_ID,
      platform: "amazon",
      productId: SKU,
      purchaseToken: TOKEN,
    });

    expect(result).toMatchObject({ granted: false, reason: "unsupported_platform" });
    expect(googlePlayVerifier.verifyPurchase).not.toHaveBeenCalled();
    expect(walletService.addBalance).not.toHaveBeenCalled();
  });
});

describe("ordering: claim before grant", () => {
  it("claims the purchase id before crediting", async () => {
    mockDb();

    await purchaseService.redeemPurchase({
      userId: USER_ID,
      platform: "google",
      productId: SKU,
      purchaseToken: TOKEN,
    });

    const claimIndex = db.query.mock.calls.findIndex(([t]) =>
      /INSERT INTO processed_purchases/i.test(String(t))
    );
    expect(claimIndex).toBeGreaterThan(-1);
    // addBalance must not have run before the claim statement was issued.
    expect(walletService.addBalance).toHaveBeenCalled();
    expect(db.query.mock.invocationCallOrder[claimIndex]).toBeLessThan(
      walletService.addBalance.mock.invocationCallOrder[0]
    );
  });

  it("records the credits actually granted on the claim row", async () => {
    mockDb();

    await purchaseService.redeemPurchase({
      userId: USER_ID,
      platform: "google",
      productId: SKU,
      purchaseToken: TOKEN,
    });

    const claim = statementsMatching(/INSERT INTO processed_purchases/i)[0];
    expect(claim[1]).toEqual([TOKEN, "google", USER_ID, SKU, 50, "GPA.1234"]);
  });
});

describe("replay protection", () => {
  it("does not credit twice when the purchase id is already claimed", async () => {
    mockDb({ claimWins: false });

    const result = await purchaseService.redeemPurchase({
      userId: USER_ID,
      platform: "google",
      productId: SKU,
      purchaseToken: TOKEN,
    });

    expect(result).toMatchObject({ granted: false, alreadyRedeemed: true, credits: 0 });
    expect(walletService.addBalance).not.toHaveBeenCalled();
  });

  it("reports the current balance on a replay so the client can still sync", async () => {
    mockDb({ claimWins: false });
    walletService.getBalance.mockResolvedValue(123);

    const result = await purchaseService.redeemPurchase({
      userId: USER_ID,
      platform: "google",
      productId: SKU,
      purchaseToken: TOKEN,
    });

    expect(result.balance).toBe(123);
  });
});

describe("verification failures never credit", () => {
  const cases = [
    ["purchase_not_found", false],
    ["purchase_cancelled", false],
    ["already_consumed", false],
    ["purchase_pending", true],
    ["not_configured", true],
    ["verification_unavailable", true],
  ];

  it.each(cases)("refuses on %s and grants nothing", async (reason, retryable) => {
    mockDb();
    googlePlayVerifier.verifyPurchase.mockResolvedValue({ ok: false, reason, retryable });

    const result = await purchaseService.redeemPurchase({
      userId: USER_ID,
      platform: "google",
      productId: SKU,
      purchaseToken: TOKEN,
    });

    expect(result.granted).toBe(false);
    expect(result.reason).toBe(reason);
    expect(walletService.addBalance).not.toHaveBeenCalled();
    // And nothing is claimed, so a later legitimate retry still works.
    expect(statementsMatching(/INSERT INTO processed_purchases/i)).toHaveLength(0);
  });

  it("marks terminal reasons as non-retryable", async () => {
    mockDb();
    googlePlayVerifier.verifyPurchase.mockResolvedValue({
      ok: false,
      reason: "purchase_not_found",
      retryable: true, // even if the verifier says otherwise
    });

    const result = await purchaseService.redeemPurchase({
      userId: USER_ID,
      platform: "google",
      productId: SKU,
      purchaseToken: TOKEN,
    });

    expect(result.retryable).toBe(false);
  });
});

describe("unknown product", () => {
  it("refuses and does NOT claim, so it can be redeemed once the SKU is mapped", async () => {
    mockDb({ packFound: false });

    const result = await purchaseService.redeemPurchase({
      userId: USER_ID,
      platform: "google",
      productId: SKU,
      purchaseToken: TOKEN,
    });

    expect(result).toMatchObject({ granted: false, reason: "unknown_product", retryable: false });
    expect(statementsMatching(/INSERT INTO processed_purchases/i)).toHaveLength(0);
    expect(walletService.addBalance).not.toHaveBeenCalled();
  });
});

describe("grant failure", () => {
  it("releases the claim so the buyer is not left with a burnt token", async () => {
    mockDb();
    walletService.addBalance.mockRejectedValue(new Error("db exploded"));

    const result = await purchaseService.redeemPurchase({
      userId: USER_ID,
      platform: "google",
      productId: SKU,
      purchaseToken: TOKEN,
    });

    expect(result).toMatchObject({ granted: false, reason: "grant_failed", retryable: true });
    const release = statementsMatching(/DELETE FROM processed_purchases/i);
    expect(release).toHaveLength(1);
    expect(release[0][1]).toEqual([TOKEN]);
  });

  it("does not acknowledge a purchase it failed to credit", async () => {
    mockDb();
    walletService.addBalance.mockRejectedValue(new Error("nope"));

    await purchaseService.redeemPurchase({
      userId: USER_ID,
      platform: "google",
      productId: SKU,
      purchaseToken: TOKEN,
    });

    expect(googlePlayVerifier.acknowledgePurchase).not.toHaveBeenCalled();
  });
});

describe("acknowledgement", () => {
  it("acknowledges only after the credits are committed", async () => {
    mockDb();

    await purchaseService.redeemPurchase({
      userId: USER_ID,
      platform: "google",
      productId: SKU,
      purchaseToken: TOKEN,
    });

    expect(googlePlayVerifier.acknowledgePurchase).toHaveBeenCalledWith({
      productId: SKU,
      purchaseToken: TOKEN,
    });
    expect(walletService.addBalance.mock.invocationCallOrder[0]).toBeLessThan(
      googlePlayVerifier.acknowledgePurchase.mock.invocationCallOrder[0]
    );
  });

  it("still reports success when acknowledgement fails - the buyer has their credits", async () => {
    mockDb();
    googlePlayVerifier.acknowledgePurchase.mockResolvedValue({ ok: false, reason: "acknowledge_failed" });

    const result = await purchaseService.redeemPurchase({
      userId: USER_ID,
      platform: "google",
      productId: SKU,
      purchaseToken: TOKEN,
    });

    expect(result.granted).toBe(true);
    expect(result.credits).toBe(50);
  });

  it("flags the row acknowledged when it succeeds", async () => {
    mockDb();

    await purchaseService.redeemPurchase({
      userId: USER_ID,
      platform: "google",
      productId: SKU,
      purchaseToken: TOKEN,
    });

    expect(statementsMatching(/SET acknowledged = TRUE/i)).toHaveLength(1);
  });
});

describe("restore", () => {
  it("redeems each purchase and sums only what was newly granted", async () => {
    let firstClaim = true;
    db.query.mockImplementation(async (text) => {
      if (/FROM credit_packs/i.test(text)) {
        return { rows: [{ id: "p", name: "Pro Pack", credits: 50, productId: SKU }], rowCount: 1 };
      }
      if (/INSERT INTO processed_purchases/i.test(text)) {
        // First wins, second is a replay.
        const wins = firstClaim;
        firstClaim = false;
        return { rows: [], rowCount: wins ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    });

    const outcome = await purchaseService.restorePurchases({
      userId: USER_ID,
      platform: "google",
      purchases: [
        { productId: SKU, purchaseToken: "tok-a" },
        { productId: SKU, purchaseToken: "tok-b" },
      ],
    });

    expect(outcome.creditsGranted).toBe(50);
    expect(outcome.results).toEqual([
      { productId: SKU, granted: true, alreadyRedeemed: false, reason: null },
      { productId: SKU, granted: false, alreadyRedeemed: true, reason: null },
    ]);
  });

  it("one bad purchase does not deny the others", async () => {
    mockDb();
    googlePlayVerifier.verifyPurchase
      .mockResolvedValueOnce({ ok: false, reason: "purchase_not_found", retryable: false })
      .mockResolvedValueOnce({ ok: true, productId: SKU, orderId: null, acknowledged: false });

    const outcome = await purchaseService.restorePurchases({
      userId: USER_ID,
      platform: "google",
      purchases: [
        { productId: SKU, purchaseToken: "bad" },
        { productId: SKU, purchaseToken: "good" },
      ],
    });

    expect(outcome.results[0]).toMatchObject({ granted: false, reason: "purchase_not_found" });
    expect(outcome.results[1]).toMatchObject({ granted: true });
    expect(outcome.creditsGranted).toBe(50);
  });
});

describe("platform configuration surface", () => {
  it("reports which verifiers can actually run", () => {
    googlePlayVerifier.isConfigured.mockReturnValue(true);
    appleVerifier.isConfigured.mockReturnValue(false);

    expect(purchaseService.configuredPlatforms()).toEqual({ google: true, apple: false });
  });
});
