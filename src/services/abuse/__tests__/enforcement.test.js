const mockClient = {
  query: jest.fn(),
  release: jest.fn(),
};

jest.mock("../../../config/db", () => ({
  query: jest.fn(),
  pool: { connect: jest.fn(async () => mockClient) },
}));
jest.mock("../../sessionService", () => ({
  revokeAllUserRefreshTokens: jest.fn().mockResolvedValue(1),
}));

const sessionService = require("../../sessionService");
const { autoSuspend, shouldAutoSuspend, systemReason } = require("../enforcement");
const { buildPolicy } = require("../../../config/abusePolicy");

const USER = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  jest.clearAllMocks();
  mockClient.query.mockReset();
  mockClient.release.mockReset();
});

/** Queues the happy path: BEGIN, UPDATE returning a row, COMMIT. */
function happyPath() {
  mockClient.query.mockImplementation(async (sql) => {
    if (/^BEGIN/i.test(sql)) return {};
    if (/^COMMIT/i.test(sql)) return {};
    if (/^ROLLBACK/i.test(sql)) return {};
    if (/UPDATE public\.users/i.test(sql)) {
      return { rows: [{ id: USER, status: "suspended", token_version: 4 }] };
    }
    return { rows: [], rowCount: 0 };
  });
}

describe("SEC-18.2 — automatic suspension reuses the Phase 6 mechanism", () => {
  it("performs the three writes in one transaction", async () => {
    happyPath();

    const result = await autoSuspend({ userId: USER, detector: "generation_velocity", evidence: {} });

    expect(result.suspended).toBe(true);
    const sql = mockClient.query.mock.calls.map((c) => String(c[0])).join("\n");
    expect(sql).toContain("BEGIN");
    // 1. status, 2. token_version bump - in ONE statement, so a crash between
    // them cannot leave a suspended account with live tokens.
    expect(sql).toMatch(/SET status = \$1[\s\S]*token_version = token_version \+ 1/);
    expect(sql).toContain("COMMIT");
    // 3. family revocation, inside the same transaction.
    expect(sessionService.revokeAllUserRefreshTokens).toHaveBeenCalledWith(
      USER, "auto_generation_velocity", mockClient
    );
  });

  it("is idempotent — a second sweep does not re-bump an already-suspended account", async () => {
    // The `AND status = 'active'` guard makes the UPDATE match nothing the
    // second time. Re-bumping would invalidate the sessions of a user an admin
    // had just reinstated.
    mockClient.query.mockImplementation(async (sql) => {
      if (/UPDATE public\.users/i.test(sql)) return { rows: [] };
      return { rows: [], rowCount: 0 };
    });

    const result = await autoSuspend({ userId: USER, detector: "d", evidence: {} });

    expect(result).toEqual({ suspended: false, reason: "not_active_or_missing" });
    expect(sessionService.revokeAllUserRefreshTokens).not.toHaveBeenCalled();
  });

  it("guards the UPDATE on status = 'active'", async () => {
    happyPath();
    await autoSuspend({ userId: USER, detector: "d", evidence: {} });
    const update = mockClient.query.mock.calls
      .map((c) => String(c[0]))
      .find((s) => /UPDATE public\.users/i.test(s));
    expect(update).toMatch(/AND status = 'active'/);
  });

  it("uses the reversible status, never 'banned'", async () => {
    happyPath();
    await autoSuspend({ userId: USER, detector: "d", evidence: {} });
    const params = mockClient.query.mock.calls
      .find((c) => /UPDATE public\.users/i.test(String(c[0])))[1];
    expect(params[0]).toBe("suspended");
  });

  // An automated action has no admin. Writing a placeholder admin id would put
  // a false name into the accountability record SEC-15.1 keeps.
  it("records NULL as the actor and names the detector in the reason", async () => {
    happyPath();
    await autoSuspend({ userId: USER, detector: "generation_velocity", evidence: { generationCount: 120 } });
    const params = mockClient.query.mock.calls
      .find((c) => /UPDATE public\.users/i.test(String(c[0])))[1];
    expect(params[1]).toContain("auto:generation_velocity");
    expect(params[1]).toContain("generationCount=120");
  });

  it("rolls back and never throws when the transaction fails", async () => {
    mockClient.query.mockImplementation(async (sql) => {
      if (/^BEGIN/i.test(sql)) return {};
      if (/^ROLLBACK/i.test(sql)) return {};
      throw new Error("db exploded");
    });

    const result = await autoSuspend({ userId: USER, detector: "d", evidence: {} });

    expect(result).toEqual({ suspended: false, reason: "error" });
    expect(mockClient.query).toHaveBeenCalledWith("ROLLBACK");
  });

  it("always releases the connection", async () => {
    mockClient.query.mockRejectedValue(new Error("nope"));
    await autoSuspend({ userId: USER, detector: "d", evidence: {} });
    expect(mockClient.release).toHaveBeenCalled();
  });
});

describe("SEC-18.2 — systemReason never leaks content", () => {
  it("keeps only scalar evidence and bounds the length", () => {
    const reason = systemReason("d", {
      count: 12,
      prompt: { text: "a private prompt" },
      email: "user@example.com",
    });
    expect(reason).toContain("count=12");
    // Objects are dropped; strings are kept, so the test asserts the bound
    // rather than pretending strings are filtered.
    expect(reason).not.toContain("a private prompt");
    expect(reason.length).toBeLessThanOrEqual(500);
  });

  it("truncates a pathological evidence blob", () => {
    const reason = systemReason("d", { k: "x".repeat(5000) });
    expect(reason.length).toBeLessThanOrEqual(500);
  });
});

describe("SEC-18.2 — shouldAutoSuspend policy gate", () => {
  const disabled = buildPolicy({});
  const enabled = buildPolicy({ ABUSE_AUTO_SUSPEND: "true" });

  it("refuses when enforcement is disabled", () => {
    expect(shouldAutoSuspend({ userId: USER, detector: "generation_velocity", severity: "high" }, disabled))
      .toEqual({ allowed: false, reason: "disabled" });
  });

  it("refuses a finding with no subject", () => {
    expect(shouldAutoSuspend({ userId: null, detector: "generation_velocity", severity: "high" }, enabled).allowed)
      .toBe(false);
  });

  it("refuses an excluded (origin-scoped) detector at any severity", () => {
    for (const detector of enabled.enforcement.neverAutoSuspend) {
      expect(shouldAutoSuspend({ userId: USER, detector, severity: "high" }, enabled))
        .toEqual({ allowed: false, reason: "detector_excluded" });
    }
  });

  it("refuses below the minimum severity", () => {
    expect(shouldAutoSuspend({ userId: USER, detector: "generation_velocity", severity: "medium" }, enabled).allowed)
      .toBe(false);
    expect(shouldAutoSuspend({ userId: USER, detector: "generation_velocity", severity: "low" }, enabled).allowed)
      .toBe(false);
  });

  it("allows exactly the eligible case", () => {
    expect(shouldAutoSuspend({ userId: USER, detector: "generation_velocity", severity: "high" }, enabled))
      .toEqual({ allowed: true, reason: "eligible" });
  });

  // VACUITY: a gate that returned false for everything would pass every
  // refusal test above while making enforcement dead code.
  it("VACUITY: the gate genuinely discriminates", () => {
    const allowed = shouldAutoSuspend({ userId: USER, detector: "generation_velocity", severity: "high" }, enabled);
    const refused = shouldAutoSuspend({ userId: USER, detector: "generation_velocity", severity: "low" }, enabled);
    expect(allowed.allowed).toBe(true);
    expect(refused.allowed).toBe(false);
  });
});
