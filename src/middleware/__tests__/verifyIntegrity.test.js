// SEC-0.2 — verifyIntegrity.
//
// The assertions that matter most here are negative and structural: that this
// middleware NEVER denies, NEVER throws, and NEVER decodes a token twice. The
// last one is not a performance property - Google clears the verdicts of a
// token decoded more than once, so a second decode turns a legitimate 401
// retry into something SEC-0.5 would read as an attack.

// Config is captured at module load, so the environment has to be set first.
process.env.PLAY_INTEGRITY_PACKAGE_NAME = "com.prombt.prombt_app";
process.env.PLAY_INTEGRITY_ENFORCEMENT = "log";
process.env.PLAY_INTEGRITY_MAX_AGE_MS = "300000";
process.env.PLAY_INTEGRITY_DECODE_RATE_LIMIT = "3";
process.env.PLAY_INTEGRITY_POLL_ATTEMPTS = "2";
process.env.PLAY_INTEGRITY_POLL_INTERVAL_MS = "5";

jest.mock("../../models/integrityVerdictModel");
jest.mock("../../services/playIntegrityService", () => {
  const crypto = require("crypto");
  return {
    hashToken: (t) => crypto.createHash("sha256").update(t, "utf8").digest("hex"),
    decodeToken: jest.fn(),
  };
});

const integrityVerdictModel = require("../../models/integrityVerdictModel");
const playIntegrityService = require("../../services/playIntegrityService");
const verifyIntegrity = require("../verifyIntegrity");
const { IntegrityStatus, __testing } = verifyIntegrity;

const TOKEN = "t".repeat(120);

function makeReq(overrides = {}) {
  return {
    method: "POST",
    baseUrl: "/api/wallet",
    path: "/reward",
    ip: "203.0.113.9",
    user: { id: "user-1" },
    body: {},
    get: (name) => (name.toLowerCase() === "x-integrity-token" ? overrides.token : undefined),
    ...overrides,
  };
}

/** Runs the middleware and resolves once next() has been called. */
function run(req) {
  return new Promise((resolve) => verifyIntegrity(req, {}, () => resolve(req.integrity)));
}

function goodVerdict(requestHash) {
  return {
    requestDetails: {
      requestPackageName: "com.prombt.prombt_app",
      requestHash,
      timestampMillis: String(Date.now()),
    },
    appIntegrity: {
      appRecognitionVerdict: "PLAY_RECOGNIZED",
      packageName: "com.prombt.prombt_app",
      certificateSha256Digest: ["abc"],
    },
    deviceIntegrity: { deviceRecognitionVerdict: ["MEETS_DEVICE_INTEGRITY"] },
    accountDetails: { appLicensingVerdict: "LICENSED" },
  };
}

const rewardHash = __testing.sha256Base64Url("POST /api/wallet/reward");

beforeEach(() => {
  jest.clearAllMocks();
  __testing.inFlight.clear();
  __testing.decodeBudget.clear();
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
  integrityVerdictModel.get.mockResolvedValue(null);
  integrityVerdictModel.claim.mockResolvedValue({ claimed: true });
  integrityVerdictModel.complete.mockResolvedValue(undefined);
});

afterEach(() => {
  console.log.mockRestore();
  console.error.mockRestore();
});

describe("it never denies and never throws", () => {
  it("calls next() and sets req.integrity even with no header", async () => {
    const annotation = await run(makeReq());

    expect(annotation.status).toBe(IntegrityStatus.ABSENT);
    expect(annotation.detail).toBe("header_missing");
  });

  it("calls next() when the model layer throws outright", async () => {
    integrityVerdictModel.get.mockRejectedValue(new Error("db down"));

    const annotation = await run(makeReq({ token: TOKEN }));

    // A defence-in-depth signal must never be the reason a paying user's
    // generation fails.
    expect(annotation.status).toBe(IntegrityStatus.DECODE_UNAVAILABLE);
  });

  it("never writes a status outside the approved taxonomy", async () => {
    playIntegrityService.decodeToken.mockResolvedValue({ ok: true, verdict: goodVerdict(rewardHash) });

    const annotation = await run(makeReq({ token: TOKEN }));

    expect(Object.values(IntegrityStatus)).toContain(annotation.status);
  });
});

describe("decrypt-once", () => {
  it("decodes exactly once for N concurrent callers with the same token", async () => {
    playIntegrityService.decodeToken.mockImplementation(
      () => new Promise((r) => setTimeout(() => r({ ok: true, verdict: goodVerdict(rewardHash) }), 20))
    );

    const results = await Promise.all([
      run(makeReq({ token: TOKEN })),
      run(makeReq({ token: TOKEN })),
      run(makeReq({ token: TOKEN })),
      run(makeReq({ token: TOKEN })),
    ]);

    // The whole point of the in-flight promise map. A second decode would come
    // back with cleared verdicts and look like an attack.
    expect(playIntegrityService.decodeToken).toHaveBeenCalledTimes(1);
    results.forEach((r) => expect(r.status).toBe(IntegrityStatus.OK));
  });

  it("reuses the stored verdict instead of decoding again (the 401 retry)", async () => {
    integrityVerdictModel.get.mockResolvedValue({
      status: "done",
      verdict: goodVerdict(rewardHash),
      verdict_usable: true,
      request_hash: rewardHash,
    });

    const annotation = await run(makeReq({ token: TOKEN }));

    expect(playIntegrityService.decodeToken).not.toHaveBeenCalled();
    expect(integrityVerdictModel.claim).not.toHaveBeenCalled();
    expect(annotation.status).toBe(IntegrityStatus.OK);
    expect(annotation.cached).toBe(true);
  });

  it("waits for another process's claim rather than decoding in parallel", async () => {
    integrityVerdictModel.claim.mockResolvedValue({ claimed: false });
    integrityVerdictModel.get
      .mockResolvedValueOnce(null)
      .mockResolvedValue({
        status: "done",
        verdict: goodVerdict(rewardHash),
        verdict_usable: true,
        request_hash: rewardHash,
      });

    const annotation = await run(makeReq({ token: TOKEN }));

    expect(playIntegrityService.decodeToken).not.toHaveBeenCalled();
    expect(annotation.status).toBe(IntegrityStatus.OK);
  });

  it("gives up as UNAVAILABLE if the other claim never resolves", async () => {
    integrityVerdictModel.claim.mockResolvedValue({ claimed: false });
    integrityVerdictModel.get.mockResolvedValue(null);

    const annotation = await run(makeReq({ token: TOKEN }));

    expect(playIntegrityService.decodeToken).not.toHaveBeenCalled();
    expect(annotation.status).toBe(IntegrityStatus.DECODE_UNAVAILABLE);
    expect(annotation.detail).toBe("claim_held_elsewhere");
  });
});

describe("replay", () => {
  it("flags the same token presented for a different request", async () => {
    integrityVerdictModel.get.mockResolvedValue({
      status: "done",
      verdict: goodVerdict("some-other-hash"),
      verdict_usable: true,
      request_hash: "some-other-hash",
    });

    const annotation = await run(makeReq({ token: TOKEN }));

    // Legitimate reuse is narrow: same token, same request, inside the window.
    expect(annotation.status).toBe(IntegrityStatus.REPLAYED);
    expect(annotation.detail).toBe("different_request");
  });

  it("flags a token whose cached verdict has aged out", async () => {
    integrityVerdictModel.get.mockResolvedValue({
      status: "done",
      verdict: null,
      verdict_usable: false,
      request_hash: rewardHash,
    });

    const annotation = await run(makeReq({ token: TOKEN }));

    expect(annotation.status).toBe(IntegrityStatus.REPLAYED);
    expect(annotation.detail).toBe("verdict_expired");
  });

  it("reads a cleared verdict as replay, not as a package mismatch", async () => {
    // This is precisely the double-decrypt signature Google documents: device
    // verdict gone, app verdict UNEVALUATED, packageName absent. Reporting it
    // as PACKAGE_MISMATCH would blame the caller for our own bug.
    playIntegrityService.decodeToken.mockResolvedValue({
      ok: true,
      verdict: {
        requestDetails: { requestHash: rewardHash, timestampMillis: String(Date.now()) },
        appIntegrity: { appRecognitionVerdict: "UNEVALUATED" },
        deviceIntegrity: {},
        accountDetails: { appLicensingVerdict: "UNEVALUATED" },
      },
    });

    const annotation = await run(makeReq({ token: TOKEN }));

    expect(annotation.status).toBe(IntegrityStatus.REPLAYED);
    expect(annotation.detail).toBe("cleared_verdict");
  });
});

describe("verdict validation", () => {
  it("rejects a request-hash mismatch", async () => {
    playIntegrityService.decodeToken.mockResolvedValue({
      ok: true,
      verdict: goodVerdict("hash-for-a-different-request"),
    });

    const annotation = await run(makeReq({ token: TOKEN }));

    expect(annotation.status).toBe(IntegrityStatus.REQUEST_MISMATCH);
  });

  it("validates appIntegrity.packageName, not requestDetails.requestPackageName", async () => {
    // Google: requestPackageName "might be spoofed in the middle of the
    // request". Checking it instead would look like a control and be none.
    const verdict = goodVerdict(rewardHash);
    verdict.requestDetails.requestPackageName = "com.prombt.prombt_app";
    verdict.appIntegrity.packageName = "com.attacker.repack";

    playIntegrityService.decodeToken.mockResolvedValue({ ok: true, verdict });

    const annotation = await run(makeReq({ token: TOKEN }));

    expect(annotation.status).toBe(IntegrityStatus.PACKAGE_MISMATCH);
  });

  it("rejects a token older than the freshness window", async () => {
    const verdict = goodVerdict(rewardHash);
    verdict.requestDetails.timestampMillis = String(Date.now() - 10 * 60 * 1000);

    playIntegrityService.decodeToken.mockResolvedValue({ ok: true, verdict });

    const annotation = await run(makeReq({ token: TOKEN }));

    expect(annotation.status).toBe(IntegrityStatus.STALE);
  });

  it("accepts a well-formed, fresh, matching verdict", async () => {
    playIntegrityService.decodeToken.mockResolvedValue({ ok: true, verdict: goodVerdict(rewardHash) });

    const annotation = await run(makeReq({ token: TOKEN }));

    expect(annotation.status).toBe(IntegrityStatus.OK);
    expect(annotation.verdict.appIntegrity.appRecognitionVerdict).toBe("PLAY_RECOGNIZED");
  });
});

describe("attacker vs outage", () => {
  it("separates a Google outage from a rejected token", async () => {
    playIntegrityService.decodeToken.mockResolvedValue({
      ok: false,
      unavailable: true,
      detail: "timeout",
    });
    const outage = await run(makeReq({ token: TOKEN }));

    __testing.inFlight.clear();
    playIntegrityService.decodeToken.mockResolvedValue({
      ok: false,
      unavailable: false,
      detail: "http_400",
    });
    const rejected = await run(makeReq({ token: "u".repeat(120) }));

    // SEC-0.5 has to be able to fail closed on the second without failing
    // closed on the first. Collapsing these would force it to pick one.
    expect(outage.status).toBe(IntegrityStatus.DECODE_UNAVAILABLE);
    expect(rejected.status).toBe(IntegrityStatus.DECODE_FAILED);
  });

  it("rejects an implausible token without spending a Google decode", async () => {
    const annotation = await run(makeReq({ token: "short" }));

    expect(annotation.status).toBe(IntegrityStatus.MALFORMED);
    expect(playIntegrityService.decodeToken).not.toHaveBeenCalled();
  });
});

describe("decode budget", () => {
  it("stops calling Google past the budget, without denying anything", async () => {
    playIntegrityService.decodeToken.mockResolvedValue({ ok: true, verdict: goodVerdict(rewardHash) });

    const statuses = [];
    for (let i = 0; i < 5; i += 1) {
      __testing.inFlight.clear();
      statuses.push((await run(makeReq({ token: `${i}`.padEnd(120, "x") }))).status);
    }

    // Budget is 3 in this suite's env.
    expect(playIntegrityService.decodeToken).toHaveBeenCalledTimes(3);
    expect(statuses[4]).toBe(IntegrityStatus.DECODE_UNAVAILABLE);
    // Never a rejection - just no verdict. SEC-0.5 decides what that means.
    expect(statuses.every((s) => Object.values(IntegrityStatus).includes(s))).toBe(true);
  });
});

describe("the raw token never escapes", () => {
  it("is absent from the annotation, the log line and every model call", async () => {
    playIntegrityService.decodeToken.mockResolvedValue({ ok: true, verdict: goodVerdict(rewardHash) });

    const annotation = await run(makeReq({ token: TOKEN }));

    const serialisedAnnotation = JSON.stringify(annotation);
    const logged = console.log.mock.calls.map((c) => String(c[0])).join("\n");
    const modelArgs = JSON.stringify([
      integrityVerdictModel.claim.mock.calls,
      integrityVerdictModel.complete.mock.calls,
      integrityVerdictModel.get.mock.calls,
    ]);

    expect(serialisedAnnotation).not.toContain(TOKEN);
    expect(logged).not.toContain(TOKEN);
    expect(modelArgs).not.toContain(TOKEN);

    // What IS carried is a digest prefix - enough to correlate two sightings,
    // useless to anyone who steals the log.
    expect(annotation.tokenDigest).toHaveLength(12);
    expect(logged).toContain(annotation.tokenDigest);
  });
});

describe("canonical request strings (the SEC-0.1 contract)", () => {
  const { canonicalRequestFor } = __testing;

  it("rebuilds /api/generate from the parsed multipart request", () => {
    const req = {
      baseUrl: "/api/generate",
      path: "/",
      route: { path: "/" },
      body: { styleId: "style-9", fieldValues: '{"a":1}' },
      files: [{}, {}],
    };

    expect(canonicalRequestFor(req)).toBe("POST /api/generate\nstyle-9\n{\"a\":1}\nfiles:2");
  });

  it("omits fieldValues when the client omitted them", () => {
    const req = { baseUrl: "/api/generate", path: "/", route: { path: "/" }, body: { styleId: "s" }, files: [{}] };

    expect(canonicalRequestFor(req)).toBe("POST /api/generate\ns\nfiles:1");
  });

  it("uses the RAW body for /api/ai/generate, not a re-serialisation", () => {
    // Key order and spacing differ between the client's encoder and
    // JSON.stringify(req.body); using the parsed object would mismatch on
    // every single request.
    const raw = '{"styleId":"s","prompt":"a cat"}';
    const req = {
      baseUrl: "/api/ai",
      path: "/generate",
      body: { prompt: "a cat", styleId: "s" },
      rawBody: Buffer.from(raw, "utf8"),
    };

    expect(canonicalRequestFor(req)).toBe(`POST /api/ai/generate\n${raw}`);
  });

  it("binds only the action for /api/wallet/reward", () => {
    expect(canonicalRequestFor({ baseUrl: "/api/wallet", path: "/reward", body: {} }))
      .toBe("POST /api/wallet/reward");
  });

  it("binds the account, never the password, for /api/auth/login", () => {
    const req = { baseUrl: "/api/auth", path: "/login", body: { email: "a@b.co", password: "hunter2" } };

    const canonical = canonicalRequestFor(req);

    expect(canonical).toBe("POST /api/auth/login\na@b.co");
    expect(canonical).not.toContain("hunter2");
  });

  it("returns null for an unwired route rather than guessing", () => {
    expect(canonicalRequestFor({ baseUrl: "/api/styles", path: "/", body: {} })).toBeNull();
  });
});
