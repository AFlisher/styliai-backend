// SEC-7.1 Stage 1 — Stability's status -> kind mapping.
//
// The controller tests construct a StabilityApiError with a kind already set,
// so they never exercise this mapping. A vacuity probe caught that: collapsing
// 403 back into `bad_request` broke nothing. These close it.

// stabilityService pulls in imageStorageService, which constructs a Supabase
// client at import time - the same reason the controller tests use explicit
// factory mocks rather than automocking.
jest.mock("../../config/supabase", () => ({ storage: { from: jest.fn() } }));

const { __testing } = require("../stabilityService");
const { errorKindForStatus } = __testing;

describe("errorKindForStatus", () => {
  it("treats 403 as a content-moderation refusal", () => {
    // Stability returns 403 when its filters reject the request. It used to be
    // grouped with the malformed-request statuses, so a policy refusal was
    // reported to the user as a bad payload and to us as nothing at all.
    expect(errorKindForStatus(403)).toBe("content_moderation");
  });

  it.each([[400], [413], [422]])("keeps %s a malformed request, not moderation", (status) => {
    expect(errorKindForStatus(status)).toBe("bad_request");
  });

  it.each([
    [401, "invalid_api_key"],
    [402, "insufficient_credits"],
    [429, "rate_limited"],
    [500, "provider_error"],
    [503, "provider_error"],
  ])("leaves %s mapping to %s", (status, kind) => {
    expect(errorKindForStatus(status)).toBe(kind);
  });

  it("never reports a provider failure as moderation", () => {
    // The inverse of the split: an outage must not be reported to a user as a
    // content-policy violation.
    for (const status of [500, 502, 503, 504]) {
      expect(errorKindForStatus(status)).not.toBe("content_moderation");
    }
  });
});
