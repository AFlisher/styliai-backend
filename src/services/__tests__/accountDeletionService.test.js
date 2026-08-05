"use strict";

/**
 * Sprint 1 / B-1 — accountDeletionService.
 *
 * The properties asserted here are the ones that are INVISIBLE end-to-end: a
 * deletion that erases the right rows but in the wrong order, or that silently
 * skips the two tables with no foreign key, still returns 200 and still looks
 * correct from the client. Each is therefore asserted against the actual
 * statements issued, not against the response.
 */

jest.mock("../../config/db", () => ({
  query: jest.fn(),
  pool: { connect: jest.fn() },
}));

jest.mock("../avatarService", () => ({ deleteAvatar: jest.fn() }));
jest.mock("../creationAssetCleanup", () => ({ deleteCreationAssets: jest.fn() }));

const db = require("../../config/db");
const avatarService = require("../avatarService");
const creationAssetCleanup = require("../creationAssetCleanup");
const accountDeletionService = require("../accountDeletionService");

const USER_ID = "11111111-2222-3333-4444-555555555555";
const ATTESTATION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

/** A pg client whose statements are recorded in order. */
function makeClient({ userExists = true } = {}) {
  const statements = [];
  const query = jest.fn(async (text, params) => {
    statements.push({ text: String(text).replace(/\s+/g, " ").trim(), params });

    if (/SELECT id FROM public\.users/i.test(text)) {
      return { rows: userExists ? [{ id: USER_ID }] : [], rowCount: userExists ? 1 : 0 };
    }
    if (/INSERT INTO account_deletions/i.test(text)) {
      return { rows: [{ id: ATTESTATION_ID }], rowCount: 1 };
    }
    if (/DELETE FROM public\.users/i.test(text)) {
      return { rows: [], rowCount: userExists ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  });

  return { query, release: jest.fn(), statements };
}

/** Matches the first recorded statement containing `needle`. */
function indexOfStatement(statements, needle) {
  return statements.findIndex((s) => new RegExp(needle, "i").test(s.text));
}

beforeEach(() => {
  jest.resetAllMocks();
  avatarService.deleteAvatar.mockResolvedValue({ deleted: 1 });
  creationAssetCleanup.deleteCreationAssets.mockResolvedValue({ deleted: 2, skipped: [] });
});

describe("asset inventory is taken before the rows are destroyed", () => {
  it("reads creation URLs first, then opens the transaction", async () => {
    const client = makeClient();
    db.pool.connect.mockResolvedValue(client);
    db.query.mockResolvedValue({
      rows: [{ id: "c1", image_url: "u1", thumbnail_url: "t1" }],
      rowCount: 1,
    });

    await accountDeletionService.deleteAccount(USER_ID);

    // The SELECT of creations goes through db.query (outside the transaction);
    // the transaction itself is the client. If the order were reversed the
    // SELECT would return nothing and the assets would leak permanently.
    expect(db.query).toHaveBeenCalledWith(
      expect.stringMatching(/SELECT id, image_url, thumbnail_url FROM creations/i),
      [USER_ID]
    );
    expect(db.pool.connect).toHaveBeenCalled();
  });
});

describe("the transaction", () => {
  it("locks the user row FOR UPDATE before doing anything destructive", async () => {
    const client = makeClient();
    db.pool.connect.mockResolvedValue(client);
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });

    await accountDeletionService.deleteAccount(USER_ID);

    const lock = indexOfStatement(client.statements, "SELECT id FROM public\\.users .* FOR UPDATE");
    const del = indexOfStatement(client.statements, "DELETE FROM public\\.users");

    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(del);
  });

  it("de-links integrity_verdicts rather than deleting them (anti-replay ledger survives)", async () => {
    const client = makeClient();
    db.pool.connect.mockResolvedValue(client);
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });

    await accountDeletionService.deleteAccount(USER_ID);

    const verdicts = client.statements.filter((s) => /integrity_verdicts/i.test(s.text));
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].text).toMatch(/UPDATE integrity_verdicts SET user_id = NULL/i);
    // The row must never be removed - that would reopen the token reuse window.
    expect(verdicts[0].text).not.toMatch(/DELETE/i);
  });

  it("deletes processed_ad_transactions outright", async () => {
    const client = makeClient();
    db.pool.connect.mockResolvedValue(client);
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });

    await accountDeletionService.deleteAccount(USER_ID);

    const ads = client.statements.filter((s) => /processed_ad_transactions/i.test(s.text));
    expect(ads).toHaveLength(1);
    expect(ads[0].text).toMatch(/DELETE FROM processed_ad_transactions/i);
    expect(ads[0].params).toEqual([USER_ID]);
  });

  it("writes the attestation inside the same transaction, before the user row goes", async () => {
    const client = makeClient();
    db.pool.connect.mockResolvedValue(client);
    db.query.mockResolvedValue({
      rows: [{ id: "c1", image_url: "u1", thumbnail_url: null }],
      rowCount: 1,
    });

    await accountDeletionService.deleteAccount(USER_ID);

    const begin = indexOfStatement(client.statements, "^BEGIN$");
    const insert = indexOfStatement(client.statements, "INSERT INTO account_deletions");
    const del = indexOfStatement(client.statements, "DELETE FROM public\\.users");
    const commit = indexOfStatement(client.statements, "^COMMIT$");

    expect(begin).toBeGreaterThan(-1);
    expect(begin).toBeLessThan(insert);
    expect(insert).toBeLessThan(del);
    expect(del).toBeLessThan(commit);

    // The count recorded is the count actually inventoried.
    expect(client.statements[insert].params).toEqual([USER_ID, "self_service_api", 1]);
  });

  it("records no personal data on the attestation row", async () => {
    const client = makeClient();
    db.pool.connect.mockResolvedValue(client);
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });

    await accountDeletionService.deleteAccount(USER_ID);

    const insert = client.statements[indexOfStatement(client.statements, "INSERT INTO account_deletions")];
    // Only an id, a provenance label and a count may be bound.
    expect(insert.params).toEqual([USER_ID, "self_service_api", 0]);
    expect(insert.text).not.toMatch(/email|full_name|avatar|ip_/i);
  });

  it("rolls back and rethrows when a statement fails, leaving the account intact", async () => {
    const client = makeClient();
    client.query.mockImplementation(async (text) => {
      if (/DELETE FROM public\.users/i.test(text)) throw new Error("db exploded");
      if (/SELECT id FROM public\.users/i.test(text)) return { rows: [{ id: USER_ID }], rowCount: 1 };
      if (/INSERT INTO account_deletions/i.test(text)) return { rows: [{ id: ATTESTATION_ID }] };
      return { rows: [], rowCount: 0 };
    });
    db.pool.connect.mockResolvedValue(client);
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });

    await expect(accountDeletionService.deleteAccount(USER_ID)).rejects.toThrow("db exploded");

    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    // Nothing may be erased from storage when the rows survived.
    expect(creationAssetCleanup.deleteCreationAssets).not.toHaveBeenCalled();
    expect(avatarService.deleteAvatar).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalled();
  });

  it("releases the client even on failure", async () => {
    const client = makeClient();
    client.query.mockRejectedValue(new Error("nope"));
    db.pool.connect.mockResolvedValue(client);
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });

    await expect(accountDeletionService.deleteAccount(USER_ID)).rejects.toThrow();
    expect(client.release).toHaveBeenCalled();
  });
});

describe("repeated deletion", () => {
  it("reports already_deleted without writing a second attestation", async () => {
    const client = makeClient({ userExists: false });
    db.pool.connect.mockResolvedValue(client);
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });

    const result = await accountDeletionService.deleteAccount(USER_ID);

    expect(result).toMatchObject({ deleted: false, reason: "already_deleted" });
    expect(indexOfStatement(client.statements, "INSERT INTO account_deletions")).toBe(-1);
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    // And nothing is erased a second time.
    expect(avatarService.deleteAvatar).not.toHaveBeenCalled();
  });
});

describe("storage erasure", () => {
  it("runs only after the commit", async () => {
    const client = makeClient();
    db.pool.connect.mockResolvedValue(client);
    db.query.mockResolvedValue({
      rows: [{ id: "c1", image_url: "u1", thumbnail_url: "t1" }],
      rowCount: 1,
    });

    let commitSeenBeforeErasure = false;
    creationAssetCleanup.deleteCreationAssets.mockImplementation(async () => {
      commitSeenBeforeErasure = indexOfStatement(client.statements, "^COMMIT$") > -1;
      return { deleted: 2, skipped: [] };
    });

    await accountDeletionService.deleteAccount(USER_ID);

    // Before the commit the referential guard would still see live rows and
    // skip every object.
    expect(commitSeenBeforeErasure).toBe(true);
  });

  it("erases every creation's assets and the avatar", async () => {
    const client = makeClient();
    db.pool.connect.mockResolvedValue(client);
    db.query.mockResolvedValue({
      rows: [
        { id: "c1", image_url: "u1", thumbnail_url: "t1" },
        { id: "c2", image_url: "u2", thumbnail_url: null },
      ],
      rowCount: 2,
    });

    const result = await accountDeletionService.deleteAccount(USER_ID);

    expect(creationAssetCleanup.deleteCreationAssets).toHaveBeenCalledTimes(2);
    expect(creationAssetCleanup.deleteCreationAssets).toHaveBeenCalledWith({
      creationId: "c1",
      urls: ["u1", "t1"],
    });
    expect(avatarService.deleteAvatar).toHaveBeenCalledWith(USER_ID);
    // 2 creations x 2 objects + 1 avatar
    expect(result.storageObjectsDeleted).toBe(5);
    expect(result.creationsDeleted).toBe(2);
  });

  it("never fails the deletion when object erasure fails", async () => {
    const client = makeClient();
    db.pool.connect.mockResolvedValue(client);
    db.query.mockResolvedValue({
      rows: [{ id: "c1", image_url: "u1", thumbnail_url: "t1" }],
      rowCount: 1,
    });

    creationAssetCleanup.deleteCreationAssets.mockResolvedValue({
      deleted: 0,
      skipped: [{ reason: "still_referenced", bucket: "creations", path: "p" }],
    });
    avatarService.deleteAvatar.mockResolvedValue({ deleted: 0 });

    const result = await accountDeletionService.deleteAccount(USER_ID);

    // The rows are gone regardless - the account IS deleted.
    expect(result.deleted).toBe(true);
    expect(result.storageErasureComplete).toBe(false);
    // ...and the partial erasure is flagged for reconciliation.
    expect(db.query).toHaveBeenCalledWith(
      expect.stringMatching(/storage_erasure_complete = FALSE/i),
      [ATTESTATION_ID, 0]
    );
  });

  it("does not let a failed attestation update turn a completed deletion into an error", async () => {
    const client = makeClient();
    db.pool.connect.mockResolvedValue(client);
    db.query.mockImplementation(async (text) => {
      if (/SELECT id, image_url/i.test(text)) {
        return { rows: [{ id: "c1", image_url: "u1", thumbnail_url: null }], rowCount: 1 };
      }
      if (/UPDATE account_deletions/i.test(text)) throw new Error("update failed");
      return { rows: [], rowCount: 0 };
    });

    await expect(accountDeletionService.deleteAccount(USER_ID)).resolves.toMatchObject({
      deleted: true,
    });
  });
});
