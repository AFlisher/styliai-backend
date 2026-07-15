// Covers audit findings #3 (client-trusted reward path is feature-flagged)
// and #9 (SSV replay protection claims the transaction_id atomically via
// INSERT ... ON CONFLICT before granting the reward).

jest.mock("../../config/db", () => ({ query: jest.fn(), pool: { connect: jest.fn() } }));
jest.mock("../../services/wallet/walletService", () => ({ rewardAd: jest.fn() }));

const crypto = require("crypto");
const db = require("../../config/db");
const walletService = require("../../services/wallet/walletService");
const { rewardAd, verifyRewardedAd } = require("../walletController");

function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.ENABLE_CLIENT_AD_REWARD;
});

describe("client-reported reward path (finding #3)", () => {
  it("keeps working by default (mobile app compatibility)", async () => {
    walletService.rewardAd.mockResolvedValueOnce({ rewarded: true, balance: 5 });
    const res = makeRes();
    const next = jest.fn();

    await rewardAd({ user: { id: "user-1" } }, res, next);

    expect(walletService.rewardAd).toHaveBeenCalledWith("user-1");
    expect(res.json).toHaveBeenCalledWith({ rewarded: true, balance: 5 });
  });

  it("is rejected with 403 when ENABLE_CLIENT_AD_REWARD=false (SSV-only mode)", async () => {
    process.env.ENABLE_CLIENT_AD_REWARD = "false";
    const res = makeRes();
    const next = jest.fn();

    await rewardAd({ user: { id: "user-1" } }, res, next);

    expect(walletService.rewardAd).not.toHaveBeenCalled();
    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(403);
  });
});

describe("SSV replay protection (finding #9)", () => {
  // Make the signature check pass so the tests exercise the claim logic:
  // fetch returns a matching key and the crypto verifier accepts anything.
  let fetchSpy;
  let verifySpy;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue({
      json: async () => ({ keys: [{ keyId: 42, pem: "FAKE_PEM" }] }),
    });
    verifySpy = jest.spyOn(crypto, "createVerify").mockReturnValue({
      update: jest.fn(),
      verify: jest.fn().mockReturnValue(true),
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    verifySpy.mockRestore();
  });

  function makeReq(transactionId) {
    const qs = `transaction_id=${transactionId}&user_id=user-1&key_id=42&signature=c2ln`;
    return {
      query: { transaction_id: transactionId, user_id: "user-1", key_id: "42", signature: "c2ln" },
      body: {},
      originalUrl: `/api/wallet/reward/verify?${qs}`,
    };
  }

  it("claims the transaction_id with INSERT ... ON CONFLICT before granting the reward", async () => {
    db.query.mockResolvedValueOnce({ rowCount: 1, rows: [] }); // claim insert wins
    walletService.rewardAd.mockResolvedValueOnce({ rewarded: true });
    const res = makeRes();

    await verifyRewardedAd(makeReq("tx-1"), res, jest.fn());

    const claimCall = db.query.mock.calls[0];
    expect(claimCall[0]).toContain("INSERT INTO processed_ad_transactions");
    expect(claimCall[0]).toContain("ON CONFLICT (transaction_id) DO NOTHING");
    // Claim happens before the reward is granted.
    expect(db.query.mock.invocationCallOrder[0]).toBeLessThan(
      walletService.rewardAd.mock.invocationCallOrder[0]
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it("treats a lost claim (rowCount 0) as a duplicate and grants nothing", async () => {
    db.query.mockResolvedValueOnce({ rowCount: 0, rows: [] }); // conflict: already processed
    const res = makeRes();

    await verifyRewardedAd(makeReq("tx-1"), res, jest.fn());

    expect(walletService.rewardAd).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ message: "Duplicate transaction ignored" });
  });

  it("releases the claimed transaction_id if granting the reward fails, so AdMob's retry isn't swallowed", async () => {
    db.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // claim insert
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // compensating delete
    walletService.rewardAd.mockRejectedValueOnce(new Error("db down"));
    const res = makeRes();
    const next = jest.fn();

    await verifyRewardedAd(makeReq("tx-1"), res, next);

    const deleteCall = db.query.mock.calls[1];
    expect(deleteCall[0]).toContain("DELETE FROM processed_ad_transactions");
    expect(deleteCall[1]).toEqual(["tx-1"]);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 500 }));
  });

  it("still rejects callbacks missing the signature outright", async () => {
    const next = jest.fn();
    const req = makeReq("tx-1");
    delete req.query.signature;

    await verifyRewardedAd(req, makeRes(), next);

    expect(db.query).not.toHaveBeenCalled();
    expect(next.mock.calls[0][0].statusCode).toBe(400);
  });
});
