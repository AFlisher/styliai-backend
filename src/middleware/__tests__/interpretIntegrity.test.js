// SEC-0.3 — the middleware wrapper.
//
// The interpretation itself is exhaustively covered in
// services/__tests__/integrityAssessment.test.js. What is asserted here is the
// contract with Express: it annotates, it always continues, and it never
// answers the request.

const interpretIntegrity = require("../interpretIntegrity");
const { IntegrityState } = require("../../services/integrityAssessment");

function runMiddleware(req) {
  return new Promise((resolve) => {
    // Any use of res would be enforcement, so it is a trap rather than a stub.
    const res = new Proxy(
      {},
      {
        get(_t, prop) {
          throw new Error(`interpretIntegrity touched res.${String(prop)} - it must never respond`);
        },
      }
    );
    interpretIntegrity(req, res, () => resolve(req));
  });
}

beforeEach(() => {
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  console.error.mockRestore();
});

describe("interpretIntegrity", () => {
  it("annotates req.integrityAssessment and calls next()", async () => {
    const req = {
      integrity: {
        status: "INTEGRITY_OK",
        endpoint: "POST /api/wallet/reward",
        verdict: {
          appIntegrity: { appRecognitionVerdict: "PLAY_RECOGNIZED", packageName: "com.prombt.prombt_app" },
          deviceIntegrity: { deviceRecognitionVerdict: ["MEETS_DEVICE_INTEGRITY"] },
          accountDetails: { appLicensingVerdict: "LICENSED" },
        },
      },
    };

    await runMiddleware(req);

    expect(req.integrityAssessment.state).toBe(IntegrityState.TRUSTED);
  });

  it("continues even when SEC-0.2 never ran", async () => {
    const req = {};

    await runMiddleware(req);

    // Honest about the gap: we did not look for a token, so this is not
    // MISSING - it is "we learned nothing".
    expect(req.integrityAssessment.state).toBe(IntegrityState.INDETERMINATE);
    expect(req.integrityAssessment.reason).toBe("no_integrity_annotation");
  });

  it("continues on a hostile annotation rather than failing the request", async () => {
    const req = { integrity: { status: "INTEGRITY_OK", get verdict() { throw new Error("boom"); } } };

    await runMiddleware(req);

    expect(req.integrityAssessment.state).toBe(IntegrityState.INDETERMINATE);
  });

  it("never touches the response object", async () => {
    // The Proxy in runMiddleware throws on any res access; reaching next()
    // at all proves nothing was read or written. Enforcement is SEC-0.5's.
    await expect(runMiddleware({ integrity: { status: "INTEGRITY_REPLAYED" } })).resolves.toBeDefined();
  });

  it("leaves req.integrity exactly as SEC-0.2 built it", async () => {
    const integrity = { status: "INTEGRITY_ABSENT", detail: "header_missing", endpoint: "POST /api/auth/login" };
    const snapshot = { ...integrity };

    await runMiddleware({ integrity });

    expect(integrity).toEqual(snapshot);
  });
});
