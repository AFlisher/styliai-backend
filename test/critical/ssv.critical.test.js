/**
 * Critical AdMob SSV suite (QA_TEST_PLAN.md):
 *   API-014, API-015, IT-003, IT-004, SEC-003, REG-003
 *
 * Google's key endpoint (fetch) and the RSA verifier (crypto.createVerify)
 * are stubbed so the test controls signature validity; the atomic replay
 * claim and reward grant run for real against the in-memory DB.
 */

require("./setupEnv");

jest.mock("../../src/config/db", () => require("./fakeDb"));
jest.mock("../../src/config/supabase", () => ({ storage: { from: () => ({}) } }));

const crypto = require("crypto");
const request = require("supertest");
const app = require("../../src/app");
const fakeDb = require("./fakeDb");

let signatureValid;
let fetchSpy;
let verifySpy;

beforeEach(() => {
  fakeDb.reset();
  signatureValid = true;

  fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue({
    json: async () => ({ keys: [{ keyId: 3335741209, pem: "FAKE_PEM" }] }),
  });
  verifySpy = jest.spyOn(crypto, "createVerify").mockReturnValue({
    update: jest.fn(),
    verify: () => signatureValid,
  });
});

afterEach(() => {
  fetchSpy.mockRestore();
  verifySpy.mockRestore();
});

// Google delivers SSV params in the query string; key_id is numeric-as-string.
// A key set to `undefined` in overrides is OMITTED from the query entirely
// (URLSearchParams would otherwise serialize it as the literal "undefined").
const callback = (overrides = {}) => {
  const params = {
    transaction_id: "tx-100",
    user_id: "ssv-user",
    reward_amount: "1",
    key_id: "3335741209",
    signature: "c2lnbmF0dXJl",
    ...overrides,
  };
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) search.append(k, v);
  }
  return request(app).post(`/api/wallet/reward/verify?${search.toString()}`);
};

describe("API-014 — missing signature parameters are rejected", () => {
  it("returns 400 when the signature is absent (no grant)", async () => {
    fakeDb.seedUser({ id: "ssv-user", balance: 0, ads_progress: 1 });
    const res = await callback({ signature: undefined });
    expect(res.status).toBe(400);
    expect(fakeDb.state.processedAdTx).toHaveLength(0);
  });

  it("returns 400 when key_id is absent", async () => {
    const res = await callback({ key_id: undefined });
    expect(res.status).toBe(400);
  });

  it("returns 400 when transaction_id is absent", async () => {
    const res = await callback({ transaction_id: undefined });
    expect(res.status).toBe(400);
  });
});

describe("API-015 / SEC-003 — an invalid signature is rejected", () => {
  it("returns 400 and grants nothing when the RSA verification fails", async () => {
    fakeDb.seedUser({ id: "ssv-user", balance: 0, ads_progress: 1 });
    signatureValid = false;

    const res = await callback();

    expect(res.status).toBe(400);
    expect(res.body.message || res.text).toMatch(/signature/i);
    expect(fakeDb.state.processedAdTx).toHaveLength(0);
    expect(fakeDb.state.walletTransactions).toHaveLength(0);
  });
});

describe("IT-003 — a valid, unique callback grants the reward", () => {
  it("verifies the signature, records the transaction, and processes the reward", async () => {
    // ads_progress = 1 so this (the 2nd ad) crosses the 2-ad threshold and
    // actually credits the wallet.
    fakeDb.seedUser({ id: "ssv-user", balance: 4, ads_progress: 1 });

    const res = await callback({ transaction_id: "tx-unique" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(fakeDb.state.processedAdTx.map((t) => t.transaction_id)).toContain("tx-unique");

    const user = fakeDb.state.users.find((u) => u.id === "ssv-user");
    expect(user.balance).toBe(5); // +1 credit for 2 ads
    expect(fakeDb.state.walletTransactions.some((t) => t.type === "reward")).toBe(true);
  });
});

describe("SEC-018 — a POST body cannot override the signed query-string values", () => {
  it("grants the reward to the query string's user_id/transaction_id, ignoring a conflicting body", async () => {
    fakeDb.seedUser({ id: "ssv-user", balance: 4, ads_progress: 1 });
    fakeDb.seedUser({ id: "attacker-user", balance: 0, ads_progress: 1 });

    const params = {
      transaction_id: "tx-query-signed",
      user_id: "ssv-user",
      reward_amount: "1",
      key_id: "3335741209",
      signature: "c2lnbmF0dXJl",
    };
    const search = new URLSearchParams(params);

    const res = await request(app)
      .post(`/api/wallet/reward/verify?${search.toString()}`)
      // A malicious/misbehaving caller supplies different identity/transaction
      // fields in the body. Before the fix, `{ ...req.query, ...req.body }`
      // let these silently win even though the signature only covers the
      // query string above.
      .send({ user_id: "attacker-user", transaction_id: "tx-attacker-controlled" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // The reward and the replay-protection claim both land on the
    // query-string identity, not the body-supplied one.
    expect(fakeDb.state.processedAdTx.map((t) => t.transaction_id)).toContain("tx-query-signed");
    expect(fakeDb.state.processedAdTx.map((t) => t.transaction_id)).not.toContain("tx-attacker-controlled");

    const attacker = fakeDb.state.users.find((u) => u.id === "attacker-user");
    expect(attacker.balance).toBe(0);

    const legit = fakeDb.state.users.find((u) => u.id === "ssv-user");
    expect(legit.balance).toBe(5); // +1 credit, same as the ordinary IT-003 flow
  });
});

describe("IT-004 / SEC-003 — replayed callbacks are ignored exactly once", () => {
  it("processes the first callback and ignores a byte-identical replay", async () => {
    fakeDb.seedUser({ id: "ssv-user", balance: 4, ads_progress: 1 });

    const first = await callback({ transaction_id: "tx-replay" });
    const balanceAfterFirst = fakeDb.state.users.find((u) => u.id === "ssv-user").balance;

    const second = await callback({ transaction_id: "tx-replay" });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.message).toMatch(/duplicate/i);

    // The replay granted nothing extra and did not duplicate the ledger row.
    const balanceAfterSecond = fakeDb.state.users.find((u) => u.id === "ssv-user").balance;
    expect(balanceAfterSecond).toBe(balanceAfterFirst);
    expect(fakeDb.state.processedAdTx.filter((t) => t.transaction_id === "tx-replay")).toHaveLength(1);
    expect(fakeDb.state.walletTransactions.filter((t) => t.type === "reward")).toHaveLength(1);
  });
});
