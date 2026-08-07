// Operations Center: pins that logAuthFailure/logAuthzFailure fire a
// securityEventModel.record() call shaped correctly for the new
// security_events table, in addition to their pre-existing logger/metrics
// behavior. The model itself is mocked, so this never touches config/db -
// see securityEventModel.js for why real persistence is gated off under
// NODE_ENV=test everywhere else in the suite.

jest.mock("../../models/securityEventModel", () => ({ record: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../metrics", () => ({ increment: jest.fn() }));
jest.mock("../logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() } }));

const securityEventModel = require("../../models/securityEventModel");
const { logAuthFailure, logAuthzFailure, logValidationFailure } = require("../securityEvents");

function makeReq(overrides = {}) {
  return {
    id: "req-1",
    method: "POST",
    baseUrl: "/api/admin",
    path: "/users/:id/suspend",
    ip: "203.0.113.7",
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("logAuthFailure", () => {
  it("persists an auth_failure event with the request context and reason", () => {
    const req = makeReq({ user: { id: "11111111-1111-1111-1111-111111111111" } });

    logAuthFailure(req, { reason: "wrong_password", subject: "sub-1" });

    expect(securityEventModel.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "auth_failure",
        reason: "wrong_password",
        subject: "sub-1",
        method: "POST",
        ip: "203.0.113.7",
        userId: "11111111-1111-1111-1111-111111111111",
        requestId: "req-1",
      })
    );
  });

  it("never throws even if the model rejects, since callers don't await it", () => {
    securityEventModel.record.mockRejectedValueOnce(new Error("db down"));
    expect(() => logAuthFailure(makeReq(), { reason: "no_header" })).not.toThrow();
  });
});

describe("logAuthzFailure", () => {
  it("persists an authz_failure event with required/actual in detail", () => {
    const req = makeReq({ admin: { id: "22222222-2222-2222-2222-222222222222" } });

    logAuthzFailure(req, { reason: "insufficient_role", required: "superadmin", actual: "viewer" });

    expect(securityEventModel.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "authz_failure",
        reason: "insufficient_role",
        subject: "22222222-2222-2222-2222-222222222222",
        adminId: "22222222-2222-2222-2222-222222222222",
        detail: { required: "superadmin", actual: "viewer" },
      })
    );
  });
});

describe("logValidationFailure", () => {
  it("does not persist to security_events - only auth/authz failures do", () => {
    logValidationFailure(makeReq(), { code: "bad_field", field: "email", reason: "invalid" });

    expect(securityEventModel.record).not.toHaveBeenCalled();
  });
});
