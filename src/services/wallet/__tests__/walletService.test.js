jest.mock("../../../config/db", () => ({
  query: jest.fn(),
  pool: { connect: jest.fn() },
}));

const db = require("../../../config/db");
const { addBalance, deductBalance, getBalance } = require("../walletService");

function makeMockClient(queryResponses) {
  const query = jest.fn();
  queryResponses.forEach((response) => query.mockResolvedValueOnce(response));
  return { query, release: jest.fn() };
}

describe("walletService.deductBalance", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("deducts the balance, records a negative-amount transaction, and commits", async () => {
    const client = makeMockClient([
      undefined, // BEGIN
      { rows: [{ balance: 10 }] }, // SELECT ... FOR UPDATE
      undefined, // UPDATE users SET balance
      { rows: [{ id: "txn-1" }] }, // INSERT wallet_transactions (recordTransaction)
      undefined, // COMMIT
    ]);
    db.pool.connect.mockResolvedValue(client);

    const newBalance = await deductBalance("user-1", 3, "generation", "Image generated");

    expect(newBalance).toBe(7);
    expect(client.query).toHaveBeenNthCalledWith(1, "BEGIN");
    expect(client.query).toHaveBeenNthCalledWith(
      2,
      "SELECT balance FROM users WHERE id = $1 FOR UPDATE",
      ["user-1"]
    );
    // Generation-type deductions atomically increment generated_images in the same UPDATE.
    expect(client.query).toHaveBeenNthCalledWith(
      3,
      "UPDATE users SET balance = $1, generated_images = generated_images + 1 WHERE id = $2",
      [7, "user-1"]
    );
    // The ledger row is negative for a deduction.
    expect(client.query).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining("INSERT INTO wallet_transactions"),
      [expect.any(String), "user-1", -3, "generation", "Image generated"]
    );
    expect(client.query).toHaveBeenNthCalledWith(5, "COMMIT");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("does not touch generated_images for non-generation transaction types", async () => {
    const client = makeMockClient([
      undefined,
      { rows: [{ balance: 10 }] },
      undefined,
      { rows: [{ id: "txn-1" }] },
      undefined,
    ]);
    db.pool.connect.mockResolvedValue(client);

    await deductBalance("user-1", 3, "admin", "manual adjustment");

    expect(client.query).toHaveBeenNthCalledWith(
      3,
      "UPDATE users SET balance = $1 WHERE id = $2",
      [7, "user-1"]
    );
  });

  it("throws and rolls back when the balance is insufficient", async () => {
    const client = makeMockClient([
      undefined, // BEGIN
      { rows: [{ balance: 2 }] }, // SELECT ... FOR UPDATE
      undefined, // ROLLBACK
    ]);
    db.pool.connect.mockResolvedValue(client);

    await expect(deductBalance("user-1", 3, "generation", "x")).rejects.toThrow(
      "Insufficient balance"
    );

    expect(client.query).toHaveBeenNthCalledWith(3, "ROLLBACK");
    expect(client.release).toHaveBeenCalledTimes(1);
    // Never reaches the UPDATE/INSERT steps once the balance check fails.
    expect(client.query).toHaveBeenCalledTimes(3);
  });

  it("throws when the user does not exist", async () => {
    const client = makeMockClient([undefined, { rows: [] }, undefined]);
    db.pool.connect.mockResolvedValue(client);

    await expect(deductBalance("missing-user", 1, "generation", "x")).rejects.toThrow(
      "User not found"
    );
    expect(client.query).toHaveBeenNthCalledWith(3, "ROLLBACK");
  });

  it.each([
    [0, "generation"],
    [-1, "generation"],
    [1.5, "generation"],
    [1, "not-a-real-type"],
  ])("rejects invalid input (amount=%p, type=%p) before ever opening a connection", async (amount, type) => {
    await expect(deductBalance("user-1", amount, type, "x")).rejects.toThrow();
    expect(db.pool.connect).not.toHaveBeenCalled();
  });
});

describe("walletService.addBalance", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("adds to the balance, records a positive-amount transaction, and commits", async () => {
    const client = makeMockClient([
      undefined,
      { rows: [{ balance: 4 }] },
      undefined,
      { rows: [{ id: "txn-1" }] },
      undefined,
    ]);
    db.pool.connect.mockResolvedValue(client);

    const newBalance = await addBalance("user-1", 2, "refund", "Refund for failed generation");

    expect(newBalance).toBe(6);
    expect(client.query).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining("INSERT INTO wallet_transactions"),
      [expect.any(String), "user-1", 2, "refund", "Refund for failed generation"]
    );
    expect(client.query).toHaveBeenNthCalledWith(5, "COMMIT");
  });

  it("rolls back and rethrows if the update fails partway through", async () => {
    const client = makeMockClient([
      undefined,
      { rows: [{ balance: 4 }] },
    ]);
    client.query.mockRejectedValueOnce(new Error("connection lost"));
    client.query.mockResolvedValueOnce(undefined); // ROLLBACK
    db.pool.connect.mockResolvedValue(client);

    await expect(addBalance("user-1", 2, "refund", "x")).rejects.toThrow("connection lost");
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});

describe("walletService.getBalance", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns the user's balance", async () => {
    db.query.mockResolvedValueOnce({ rows: [{ balance: 42 }] });
    await expect(getBalance("user-1")).resolves.toBe(42);
  });

  it("throws when the user does not exist", async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    await expect(getBalance("missing-user")).rejects.toThrow("User not found");
  });
});
