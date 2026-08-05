"use strict";

/**
 * Sprint 2 / B-3 — the two platform verifiers.
 *
 * The Google tests pin the mapping from Google's own response fields onto our
 * grant/refuse decision, because every one of those branches is a place where
 * getting it backwards either credits an unpaid purchase or refuses a paid one.
 *
 * The Apple tests pin something different and, right now, more important: that
 * an UNFINISHED verifier refuses. A prepared integration that quietly returns
 * ok:true would be far worse than none.
 */

const mockRequest = jest.fn();
jest.mock("google-auth-library", () => ({
  JWT: jest.fn().mockImplementation(() => ({ request: mockRequest })),
}));

const googlePlayVerifier = require("../googlePlayVerifier");
const appleVerifier = require("../appleVerifier");

const SKU = "credits_pro_50";
const TOKEN = "opaque-token";

/** A minimally valid service account. The key is syntactic, not a real key. */
const SERVICE_ACCOUNT = JSON.stringify({
  client_email: "verifier@example.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n",
});

const CONFIGURED = {
  GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: SERVICE_ACCOUNT,
  ANDROID_PACKAGE_NAME: "com.prombt.prombt_app",
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("googlePlayVerifier — configuration", () => {
  it("reports unconfigured when the service account is absent", () => {
    expect(googlePlayVerifier.isConfigured({ ANDROID_PACKAGE_NAME: "x" })).toBe(false);
  });

  it("reports unconfigured when the package name is absent", () => {
    expect(
      googlePlayVerifier.isConfigured({ GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: SERVICE_ACCOUNT })
    ).toBe(false);
  });

  it("reports configured when both are present", () => {
    expect(googlePlayVerifier.isConfigured(CONFIGURED)).toBe(true);
  });

  it("refuses retryably when unconfigured, rather than rejecting the buyer", async () => {
    const result = await googlePlayVerifier.verifyPurchase(
      { productId: SKU, purchaseToken: TOKEN },
      {}
    );

    // An operator gap must never present as a fraudulent purchase.
    expect(result).toMatchObject({ ok: false, reason: "not_configured", retryable: true });
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("survives an unparseable service account without throwing", async () => {
    const result = await googlePlayVerifier.verifyPurchase(
      { productId: SKU, purchaseToken: TOKEN },
      { GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: "{not json", ANDROID_PACKAGE_NAME: "x" }
    );

    expect(result).toMatchObject({ ok: false, reason: "not_configured" });
  });
});

describe("googlePlayVerifier — purchase states", () => {
  it("accepts a completed, unconsumed purchase", async () => {
    mockRequest.mockResolvedValue({
      data: {
        purchaseState: 0,
        consumptionState: 0,
        productId: SKU,
        orderId: "GPA.1",
        acknowledgementState: 0,
      },
    });

    const result = await googlePlayVerifier.verifyPurchase(
      { productId: SKU, purchaseToken: TOKEN },
      CONFIGURED
    );

    expect(result).toMatchObject({ ok: true, productId: SKU, orderId: "GPA.1" });
  });

  it("takes the productId from GOOGLE's response, not the request", async () => {
    mockRequest.mockResolvedValue({
      data: { purchaseState: 0, consumptionState: 0, productId: "credits_starter_10" },
    });

    const result = await googlePlayVerifier.verifyPurchase(
      { productId: "credits_max_100", purchaseToken: TOKEN },
      CONFIGURED
    );

    expect(result.productId).toBe("credits_starter_10");
  });

  it("refuses a pending purchase retryably - it is not money yet", async () => {
    mockRequest.mockResolvedValue({ data: { purchaseState: 2 } });

    const result = await googlePlayVerifier.verifyPurchase(
      { productId: SKU, purchaseToken: TOKEN },
      CONFIGURED
    );

    expect(result).toMatchObject({ ok: false, reason: "purchase_pending", retryable: true });
  });

  it("refuses a cancelled purchase terminally", async () => {
    mockRequest.mockResolvedValue({ data: { purchaseState: 1 } });

    const result = await googlePlayVerifier.verifyPurchase(
      { productId: SKU, purchaseToken: TOKEN },
      CONFIGURED
    );

    expect(result).toMatchObject({ ok: false, reason: "purchase_cancelled", retryable: false });
  });

  it("refuses an already-consumed purchase", async () => {
    mockRequest.mockResolvedValue({
      data: { purchaseState: 0, consumptionState: 1, productId: SKU },
    });

    const result = await googlePlayVerifier.verifyPurchase(
      { productId: SKU, purchaseToken: TOKEN },
      CONFIGURED
    );

    expect(result).toMatchObject({ ok: false, reason: "already_consumed", retryable: false });
  });
});

describe("googlePlayVerifier — transport failures", () => {
  it("treats 404 as a definitive no, not a retry loop", async () => {
    const err = new Error("Not Found");
    err.response = { status: 404 };
    mockRequest.mockRejectedValue(err);

    const result = await googlePlayVerifier.verifyPurchase(
      { productId: SKU, purchaseToken: TOKEN },
      CONFIGURED
    );

    expect(result).toMatchObject({ ok: false, reason: "purchase_not_found", retryable: false });
  });

  it("treats 403 as OUR problem, retryable, never the buyer's fault", async () => {
    const err = new Error("Forbidden");
    err.response = { status: 403 };
    mockRequest.mockRejectedValue(err);

    const result = await googlePlayVerifier.verifyPurchase(
      { productId: SKU, purchaseToken: TOKEN },
      CONFIGURED
    );

    expect(result).toMatchObject({ ok: false, reason: "verifier_unauthorized", retryable: true });
  });

  it("never assumes valid when Google is unreachable", async () => {
    mockRequest.mockRejectedValue(new Error("socket hang up"));

    const result = await googlePlayVerifier.verifyPurchase(
      { productId: SKU, purchaseToken: TOKEN },
      CONFIGURED
    );

    // The single most important assertion in this file.
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: "verification_unavailable", retryable: true });
  });

  it("rejects a missing token without calling Google", async () => {
    const result = await googlePlayVerifier.verifyPurchase(
      { productId: SKU, purchaseToken: "" },
      CONFIGURED
    );

    expect(result).toMatchObject({ ok: false, reason: "missing_purchase_token" });
    expect(mockRequest).not.toHaveBeenCalled();
  });
});

describe("googlePlayVerifier — acknowledgement", () => {
  it("posts to the acknowledge endpoint", async () => {
    mockRequest.mockResolvedValue({ data: {} });

    const result = await googlePlayVerifier.acknowledgePurchase(
      { productId: SKU, purchaseToken: TOKEN },
      CONFIGURED
    );

    expect(result.ok).toBe(true);
    const [call] = mockRequest.mock.calls;
    expect(call[0].url).toMatch(/:acknowledge$/);
    expect(call[0].method).toBe("POST");
  });

  it("reports failure without throwing", async () => {
    mockRequest.mockRejectedValue(new Error("boom"));

    const result = await googlePlayVerifier.acknowledgePurchase(
      { productId: SKU, purchaseToken: TOKEN },
      CONFIGURED
    );

    expect(result).toMatchObject({ ok: false, reason: "acknowledge_failed" });
  });
});

describe("appleVerifier — prepared, not active", () => {
  const APPLE_ENV = {
    APPLE_IAP_KEY_ID: "KEY123",
    APPLE_IAP_ISSUER_ID: "ISSUER123",
    APPLE_IAP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----",
    APPLE_BUNDLE_ID: "com.prombt.prombtApp",
  };

  it("reports unconfigured with no credentials", () => {
    expect(appleVerifier.isConfigured({})).toBe(false);
    expect(appleVerifier.missingConfiguration({})).toEqual(appleVerifier.REQUIRED_ENV);
  });

  it("names exactly which credentials are missing", () => {
    const missing = appleVerifier.missingConfiguration({ APPLE_IAP_KEY_ID: "x" });
    expect(missing).not.toContain("APPLE_IAP_KEY_ID");
    expect(missing).toContain("APPLE_BUNDLE_ID");
  });

  it("refuses retryably when unconfigured", async () => {
    const result = await appleVerifier.verifyPurchase(
      { productId: SKU, purchaseToken: TOKEN },
      {}
    );

    expect(result).toMatchObject({ ok: false, reason: "not_configured", retryable: true });
  });

  it("STILL refuses when credentials are present but verification is unimplemented", async () => {
    // The trap this guards: an operator sets the four variables, assumes iOS
    // purchases now work, and ships. Returning ok:true here would credit every
    // unverified payload presented.
    const result = await appleVerifier.verifyPurchase(
      { productId: SKU, purchaseToken: TOKEN },
      APPLE_ENV
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not_configured");
  });

  it("never returns ok:true from any input", async () => {
    const inputs = [
      { productId: SKU, purchaseToken: TOKEN },
      { productId: SKU, purchaseToken: "a.b.c" },
      { productId: "", purchaseToken: "" },
    ];

    for (const input of inputs) {
      // eslint-disable-next-line no-await-in-loop
      const result = await appleVerifier.verifyPurchase(input, APPLE_ENV);
      expect(result.ok).toBe(false);
    }
  });

  it("decodes a JWS payload for diagnostics but is named to prevent misuse", () => {
    const payload = Buffer.from(JSON.stringify({ productId: SKU })).toString("base64url");
    const jws = `header.${payload}.signature`;

    expect(appleVerifier.unsafeDecodeJwsPayload(jws)).toEqual({ productId: SKU });
    expect(appleVerifier.unsafeDecodeJwsPayload("not-a-jws")).toBeNull();
    expect(appleVerifier.unsafeDecodeJwsPayload(null)).toBeNull();
  });

  it("acknowledgement is a no-op success - Apple has no acknowledge step", async () => {
    await expect(appleVerifier.acknowledgePurchase()).resolves.toMatchObject({ ok: true });
  });
});
