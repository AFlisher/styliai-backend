"use strict";

/**
 * Sprint 1 / B-1 — POST /api/auth/delete-account, at the handler.
 *
 * The route-level gate (authMiddleware) is asserted in the integration suite;
 * what is asserted here is everything the handler itself decides: intent,
 * re-authentication, the OAuth asymmetry, idempotency, and the fact that a
 * failed deletion tells the caller their account is INTACT rather than gone.
 */

jest.mock("../../config/db", () => ({ query: jest.fn(), pool: { connect: jest.fn() } }));
jest.mock("../../services/accountDeletionService", () => ({ deleteAccount: jest.fn() }));
jest.mock("../../utils/securityEvents", () => ({
  logAuditEvent: jest.fn(),
  logAuthFailure: jest.fn(),
  logAuthzFailure: jest.fn(),
  logValidationFailure: jest.fn(),
  logUnexpectedError: jest.fn(),
}));

const bcrypt = require("bcrypt");
const db = require("../../config/db");
const accountDeletionService = require("../../services/accountDeletionService");
const securityEvents = require("../../utils/securityEvents");
const { deleteAccount, CONFIRMATION_PHRASE } = require("../accountDeletionController");

const USER_ID = "11111111-2222-3333-4444-555555555555";
const PASSWORD = "Str0ng!pass";

function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

function makeReq(body = {}) {
  return { user: { id: USER_ID }, body, method: "POST", baseUrl: "/api/auth", path: "/delete-account" };
}

/** Captures the AppError handed to next(). */
function makeNext() {
  const next = jest.fn();
  next.error = () => next.mock.calls[0] && next.mock.calls[0][0];
  return next;
}

let passwordHash;

beforeAll(async () => {
  passwordHash = await bcrypt.hash(PASSWORD, 10);
});

beforeEach(() => {
  jest.resetAllMocks();
  accountDeletionService.deleteAccount.mockResolvedValue({
    deleted: true,
    creationsDeleted: 3,
    storageObjectsDeleted: 7,
    storageErasureComplete: true,
  });
});

function localAccount() {
  db.query.mockResolvedValue({
    rows: [{ id: USER_ID, provider: "local", password_hash: passwordHash }],
    rowCount: 1,
  });
}

function googleAccount() {
  db.query.mockResolvedValue({
    rows: [{ id: USER_ID, provider: "google", password_hash: null }],
    rowCount: 1,
  });
}

describe("intent confirmation", () => {
  it("refuses a request with no confirmation, before reading the account", async () => {
    const res = makeRes();
    const next = makeNext();

    await deleteAccount(makeReq({ currentPassword: PASSWORD }), res, next);

    expect(next.error().statusCode).toBe(400);
    expect(db.query).not.toHaveBeenCalled();
    expect(accountDeletionService.deleteAccount).not.toHaveBeenCalled();
  });

  it("refuses a near-miss confirmation phrase", async () => {
    const res = makeRes();
    const next = makeNext();

    await deleteAccount(makeReq({ confirmation: "delete", currentPassword: PASSWORD }), res, next);

    expect(next.error().statusCode).toBe(400);
    expect(accountDeletionService.deleteAccount).not.toHaveBeenCalled();
  });
});

describe("re-authentication (password accounts)", () => {
  it("requires the current password", async () => {
    localAccount();
    const res = makeRes();
    const next = makeNext();

    await deleteAccount(makeReq({ confirmation: CONFIRMATION_PHRASE }), res, next);

    expect(next.error().statusCode).toBe(400);
    expect(accountDeletionService.deleteAccount).not.toHaveBeenCalled();
  });

  it("refuses a wrong password with 403 and never deletes", async () => {
    localAccount();
    const res = makeRes();
    const next = makeNext();

    await deleteAccount(
      makeReq({ confirmation: CONFIRMATION_PHRASE, currentPassword: "wrong-password" }),
      res,
      next
    );

    expect(next.error().statusCode).toBe(403);
    expect(accountDeletionService.deleteAccount).not.toHaveBeenCalled();
    expect(securityEvents.logAuthFailure).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reason: "delete_account_bad_password" })
    );
  });

  it("deletes when the password is correct", async () => {
    localAccount();
    const res = makeRes();
    const next = makeNext();

    await deleteAccount(
      makeReq({ confirmation: CONFIRMATION_PHRASE, currentPassword: PASSWORD }),
      res,
      next
    );

    expect(accountDeletionService.deleteAccount).toHaveBeenCalledWith(USER_ID);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ deleted: true, creationsDeleted: 3, storageObjectsDeleted: 7 })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("only ever deletes the caller's own id, ignoring any id in the body", async () => {
    localAccount();
    const res = makeRes();
    const next = makeNext();

    await deleteAccount(
      makeReq({
        confirmation: CONFIRMATION_PHRASE,
        currentPassword: PASSWORD,
        userId: "99999999-9999-9999-9999-999999999999",
        id: "88888888-8888-8888-8888-888888888888",
      }),
      res,
      next
    );

    expect(accountDeletionService.deleteAccount).toHaveBeenCalledWith(USER_ID);
    expect(db.query).toHaveBeenCalledWith(expect.any(String), [USER_ID]);
  });
});

describe("re-authentication (Google accounts)", () => {
  it("accepts the confirmation phrase alone", async () => {
    googleAccount();
    const res = makeRes();
    const next = makeNext();

    await deleteAccount(makeReq({ confirmation: CONFIRMATION_PHRASE }), res, next);

    expect(accountDeletionService.deleteAccount).toHaveBeenCalledWith(USER_ID);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("does not attempt a bcrypt compare against a null hash", async () => {
    googleAccount();
    const compare = jest.spyOn(bcrypt, "compare");
    const res = makeRes();

    await deleteAccount(
      makeReq({ confirmation: CONFIRMATION_PHRASE, currentPassword: "anything" }),
      res,
      makeNext()
    );

    expect(compare).not.toHaveBeenCalled();
    compare.mockRestore();
  });
});

describe("repeated deletion", () => {
  it("answers 200 when the row is already gone", async () => {
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });
    const res = makeRes();
    const next = makeNext();

    await deleteAccount(makeReq({ confirmation: CONFIRMATION_PHRASE }), res, next);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ deleted: true, alreadyDeleted: true })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("answers 200 when the service reports it lost the race", async () => {
    localAccount();
    accountDeletionService.deleteAccount.mockResolvedValue({
      deleted: false,
      reason: "already_deleted",
      creationsDeleted: 0,
      storageObjectsDeleted: 0,
      storageErasureComplete: true,
    });
    const res = makeRes();

    await deleteAccount(
      makeReq({ confirmation: CONFIRMATION_PHRASE, currentPassword: PASSWORD }),
      res,
      makeNext()
    );

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ deleted: true, alreadyDeleted: true })
    );
  });
});

describe("failure handling", () => {
  it("returns 500 stating the account was NOT changed when the service throws", async () => {
    localAccount();
    accountDeletionService.deleteAccount.mockRejectedValue(new Error("db exploded"));
    const res = makeRes();
    const next = makeNext();

    await deleteAccount(
      makeReq({ confirmation: CONFIRMATION_PHRASE, currentPassword: PASSWORD }),
      res,
      next
    );

    const err = next.error();
    expect(err.statusCode).toBe(500);
    // The caller must not be told their data is gone when it is not.
    expect(err.message).toMatch(/has not been changed/i);
    expect(res.json).not.toHaveBeenCalled();
  });

  it("does not leak the underlying error text to the caller", async () => {
    localAccount();
    accountDeletionService.deleteAccount.mockRejectedValue(
      new Error("connection to 10.0.0.4:5432 refused")
    );
    const next = makeNext();

    await deleteAccount(
      makeReq({ confirmation: CONFIRMATION_PHRASE, currentPassword: PASSWORD }),
      makeRes(),
      next
    );

    expect(next.error().message).not.toMatch(/10\.0\.0\.4|5432|refused/);
  });
});

describe("audit events", () => {
  it("records the attempt before erasure and the outcome after", async () => {
    localAccount();

    await deleteAccount(
      makeReq({ confirmation: CONFIRMATION_PHRASE, currentPassword: PASSWORD }),
      makeRes(),
      makeNext()
    );

    const outcomes = securityEvents.logAuditEvent.mock.calls.map((c) => c[1]);
    expect(outcomes).toEqual([
      expect.objectContaining({ action: "account_deletion", outcome: "started", subject: USER_ID }),
      expect.objectContaining({ action: "account_deletion", outcome: "success", subject: USER_ID }),
    ]);
  });

  it("records which re-authentication path was used", async () => {
    googleAccount();

    await deleteAccount(makeReq({ confirmation: CONFIRMATION_PHRASE }), makeRes(), makeNext());

    expect(securityEvents.logAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        outcome: "started",
        details: { reauth: "oauth_confirmation_only" },
      })
    );
  });

  it("records a failure outcome when the erasure throws", async () => {
    localAccount();
    accountDeletionService.deleteAccount.mockRejectedValue(new Error("nope"));

    await deleteAccount(
      makeReq({ confirmation: CONFIRMATION_PHRASE, currentPassword: PASSWORD }),
      makeRes(),
      makeNext()
    );

    expect(securityEvents.logAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "account_deletion", outcome: "failure" })
    );
    expect(securityEvents.logUnexpectedError).toHaveBeenCalled();
  });

  it("carries the erasure counts into the success event", async () => {
    localAccount();

    await deleteAccount(
      makeReq({ confirmation: CONFIRMATION_PHRASE, currentPassword: PASSWORD }),
      makeRes(),
      makeNext()
    );

    expect(securityEvents.logAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        outcome: "success",
        details: expect.objectContaining({
          creationsDeleted: 3,
          storageObjectsDeleted: 7,
          storageErasureComplete: true,
        }),
      })
    );
  });
});
