// SEC-15.1: unit-level contract for the audit middleware. The gating rules are
// the security boundary (who gets recorded, and who cannot be made to appear in
// the log), and totality is the availability boundary - this handler runs on
// res 'finish', outside Express's error pipeline, so anything it throws is an
// uncaught exception that kills the process.

jest.mock("../../models/adminAuditModel", () => ({ record: jest.fn() }));

const EventEmitter = require("events");
const adminAuditModel = require("../../models/adminAuditModel");
const auditAdminAction = require("../auditAdminAction");

function makeReq(overrides = {}) {
  return {
    method: "POST",
    originalUrl: "/api/styles",
    baseUrl: "/api/styles",
    route: { path: "/" },
    params: {},
    body: {},
    ip: "203.0.113.7",
    admin: { id: "admin-1", email: "admin@example.com", role: "admin" },
    ...overrides,
  };
}

function makeRes(statusCode = 200) {
  const res = new EventEmitter();
  res.statusCode = statusCode;
  return res;
}

/** Runs the middleware and fires the response-finished event. */
function run(req, res) {
  const next = jest.fn();
  auditAdminAction(req, res, next);
  expect(next).toHaveBeenCalledTimes(1);
  res.emit("finish");
}

beforeEach(() => {
  jest.clearAllMocks();
  adminAuditModel.record.mockResolvedValue({ id: "audit-1" });
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  console.error.mockRestore();
});

describe("what gets recorded", () => {
  it("records a successful admin mutation", async () => {
    run(makeReq({ body: { name: "Cyberpunk" } }), makeRes(201));

    expect(adminAuditModel.record).toHaveBeenCalledTimes(1);
    const entry = adminAuditModel.record.mock.calls[0][0];
    expect(entry).toMatchObject({
      adminId: "admin-1",
      adminEmail: "admin@example.com",
      action: "POST /api/styles",
      targetType: "styles",
      ip: "203.0.113.7",
      statusCode: 201,
      after: { name: "Cyberpunk" },
    });
  });

  it("names the action by route shape, not by id", () => {
    run(
      makeReq({
        method: "DELETE",
        originalUrl: "/api/styles/style-9",
        route: { path: "/:id" },
        params: { id: "style-9" },
      }),
      makeRes(204)
    );

    const entry = adminAuditModel.record.mock.calls[0][0];
    expect(entry.action).toBe("DELETE /api/styles/:id");
    expect(entry.targetId).toBe("style-9");
  });

  it("carries the deleted row through as the before-state", () => {
    const removed = { id: "style-9", name: "Old", prompt: "a portrait" };
    run(
      makeReq({ method: "DELETE", route: { path: "/:id" }, auditBefore: removed }),
      makeRes(204)
    );

    expect(adminAuditModel.record.mock.calls[0][0].before).toEqual(removed);
  });

  it("redacts credential query parameters in the stored URL (reuses SEC-16.1)", () => {
    run(makeReq({ originalUrl: "/api/styles?token=SENTINEL-SECRET" }), makeRes(200));

    const entry = adminAuditModel.record.mock.calls[0][0];
    expect(entry.requestUrl).toBe("/api/styles?token=[REDACTED]");
    expect(JSON.stringify(entry)).not.toContain("SENTINEL-SECRET");
  });
});

describe("what does NOT get recorded", () => {
  it("ignores requests with no verified admin - identity is never taken from the request", () => {
    run(makeReq({ admin: undefined }), makeRes(200));
    expect(adminAuditModel.record).not.toHaveBeenCalled();
  });

  it("ignores an admin-shaped body field - only req.admin counts", () => {
    run(makeReq({ admin: undefined, body: { admin: { id: "forged" } } }), makeRes(200));
    expect(adminAuditModel.record).not.toHaveBeenCalled();
  });

  it("ignores reads, even when an admin token is attached", () => {
    // GET /api/styles runs optionalAdminAuth and so does set req.admin.
    run(makeReq({ method: "GET" }), makeRes(200));
    expect(adminAuditModel.record).not.toHaveBeenCalled();
  });

  it.each([[400], [401], [403], [404], [409], [500]])(
    "ignores a %i response, so failed attempts cannot flood the table",
    (status) => {
      run(makeReq(), makeRes(status));
      expect(adminAuditModel.record).not.toHaveBeenCalled();
    }
  );

  it("does not double-record an action the handler already wrote in-transaction", () => {
    run(makeReq({ auditWritten: true }), makeRes(200));
    expect(adminAuditModel.record).not.toHaveBeenCalled();
  });
});

describe("totality - a failure here must not take the process down", () => {
  it("swallows a rejected insert and logs it", async () => {
    adminAuditModel.record.mockRejectedValue(new Error("relation does not exist"));

    expect(() => run(makeReq(), makeRes(200))).not.toThrow();

    // Let the rejection settle: an unhandled one terminates the process under
    // Node's default policy, so it has to be caught, not merely not-thrown.
    await new Promise((resolve) => setImmediate(resolve));
    expect(console.error).toHaveBeenCalled();
    expect(console.error.mock.calls[0][0]).toContain("[audit]");
  });

  it("swallows a synchronous throw from the insert", () => {
    adminAuditModel.record.mockImplementation(() => {
      throw new Error("boom");
    });

    expect(() => run(makeReq(), makeRes(200))).not.toThrow();
    expect(console.error).toHaveBeenCalled();
  });

  it("survives a request object with nothing on it", () => {
    const req = { method: "POST", admin: { id: "admin-1" } };
    const res = makeRes(200);

    expect(() => run(req, res)).not.toThrow();
  });

  it("still calls next() when recording is skipped", () => {
    const next = jest.fn();
    auditAdminAction(makeReq({ admin: undefined }), makeRes(200), next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
