// Covers the account-enumeration fixes from Roadmap Item 2.2: forgotPassword,
// checkVerificationStatus, and resendVerification must all respond
// identically regardless of whether the account exists.

process.env.GOOGLE_WEB_CLIENT_ID = "test-client-id"; // silence the Item 2.6 startup warning

jest.mock("../../config/db", () => ({ query: jest.fn() }));
jest.mock("../../utils/sendEmail", () => jest.fn());

const db = require("../../config/db");
const sendEmail = require("../../utils/sendEmail");
const {
  forgotPassword,
  checkVerificationStatus,
  resendVerification,
} = require("../authController");

function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("forgotPassword", () => {
  const GENERIC_MESSAGE = "If an account with this email exists, a password reset link has been sent.";

  it("responds with the generic message and sends no email for a nonexistent account", async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // SELECT user
    const req = { body: { email: "nobody@example.com" } };
    const res = makeRes();

    await forgotPassword(req, res);

    expect(res.json).toHaveBeenCalledWith({ message: GENERIC_MESSAGE });
    expect(sendEmail).not.toHaveBeenCalled();
    // Only the lookup query ran - no reset-token UPDATE for a nonexistent user.
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it("responds with the identical generic message and actually sends the email for a real account", async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: "user-1", full_name: "Real User" }] }) // SELECT user
      .mockResolvedValueOnce({ rows: [] }); // UPDATE reset_token_hash
    const req = { body: { email: "real@example.com" } };
    const res = makeRes();

    await forgotPassword(req, res);

    expect(res.json).toHaveBeenCalledWith({ message: GENERIC_MESSAGE });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "real@example.com" })
    );
  });
});

describe("checkVerificationStatus", () => {
  it("reports unverified (not a 404) for a nonexistent account", async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const req = { query: { email: "nobody@example.com" } };
    const res = makeRes();

    await checkVerificationStatus(req, res);

    expect(res.status).not.toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ verified: false });
  });

  it("reports the real verified status for an existing account", async () => {
    db.query.mockResolvedValueOnce({ rows: [{ email_verified: true }] });
    const req = { query: { email: "real@example.com" } };
    const res = makeRes();

    await checkVerificationStatus(req, res);

    expect(res.json).toHaveBeenCalledWith({ verified: true });
  });

  it("reports unverified for an existing but unverified account", async () => {
    db.query.mockResolvedValueOnce({ rows: [{ email_verified: false }] });
    const req = { query: { email: "unverified@example.com" } };
    const res = makeRes();

    await checkVerificationStatus(req, res);

    expect(res.json).toHaveBeenCalledWith({ verified: false });
  });
});

describe("resendVerification", () => {
  const GENERIC_MESSAGE =
    "If an account with this email exists and is unverified, a verification link has been sent.";

  it("responds with the generic message and sends no email for a nonexistent account", async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const req = { body: { email: "nobody@example.com" } };
    const res = makeRes();

    await resendVerification(req, res);

    expect(res.json).toHaveBeenCalledWith({ message: GENERIC_MESSAGE });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("responds with the identical generic message and sends no email for an already-verified account", async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: "user-1", full_name: "Real User", email_verified: true, verification_token: null }],
    });
    const req = { body: { email: "verified@example.com" } };
    const res = makeRes();

    await resendVerification(req, res);

    expect(res.json).toHaveBeenCalledWith({ message: GENERIC_MESSAGE });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("responds with the identical generic message and actually sends the email for an unverified account", async () => {
    db.query
      .mockResolvedValueOnce({
        rows: [{ id: "user-1", full_name: "Real User", email_verified: false, verification_token: "tok-1" }],
      })
      .mockResolvedValueOnce({ rows: [] }); // (not reached here - token already exists, no UPDATE)
    const req = { body: { email: "unverified@example.com" } };
    const res = makeRes();

    await resendVerification(req, res);

    expect(res.json).toHaveBeenCalledWith({ message: GENERIC_MESSAGE });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "unverified@example.com" })
    );
  });
});
