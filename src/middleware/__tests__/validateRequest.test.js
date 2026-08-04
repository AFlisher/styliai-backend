const {
  uuidParams,
  validateBody,
  toClientError,
  isUuid,
} = require("../validateRequest");
const { z } = require("zod");

function makeNext() {
  const calls = [];
  const next = (err) => calls.push(err);
  next.calls = calls;
  return next;
}

describe("SEC-9.1 — uuidParams", () => {
  const VALID = "550e8400-e29b-41d4-a716-446655440000";

  it("passes a well-formed uuid through with no error", () => {
    const next = makeNext();
    uuidParams("id")({ params: { id: VALID } }, {}, next);
    expect(next.calls).toEqual([undefined]);
  });

  it("accepts uppercase and mixed case, which Postgres also accepts", () => {
    const next = makeNext();
    uuidParams("id")({ params: { id: VALID.toUpperCase() } }, {}, next);
    expect(next.calls[0]).toBeUndefined();
  });

  // The finding itself: these are the inputs that used to reach Postgres and
  // come back as 22P02 -> 500.
  it.each([
    ["not-a-uuid", "obvious garbage"],
    ["", "empty"],
    ["550e8400-e29b-41d4-a716", "truncated"],
    ["550e8400-e29b-41d4-a716-44665544000g", "non-hex character"],
    ["550e8400e29b41d4a716446655440000", "no dashes"],
    [" 550e8400-e29b-41d4-a716-446655440000", "leading space"],
    ["550e8400-e29b-41d4-a716-446655440000 ", "trailing space"],
    ["550e8400-e29b-41d4-a716-446655440000'; DROP TABLE users--", "sqli-shaped"],
  ])("rejects %s (%s) with a 400", (value) => {
    const next = makeNext();
    uuidParams("id")({ params: { id: value } }, {}, next);
    const err = next.calls[0];
    expect(err).toBeDefined();
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe("VALIDATION_ERROR");
  });

  it("rejects non-string params (array from a repeated value, object, null)", () => {
    for (const value of [["a", "b"], { a: 1 }, null, undefined, 12345]) {
      const next = makeNext();
      uuidParams("id")({ params: { id: value } }, {}, next);
      expect(next.calls[0].statusCode).toBe(400);
    }
  });

  it("never echoes the offending value back, so the message is not a reflection gadget", () => {
    const next = makeNext();
    const payload = "<script>alert(1)</script>";
    uuidParams("id")({ params: { id: payload } }, {}, next);
    expect(next.calls[0].message).not.toContain(payload);
    expect(next.calls[0].message).toContain("id");
  });

  it("validates every named param, failing on the first bad one", () => {
    const next = makeNext();
    uuidParams("a", "b")({ params: { a: VALID, b: "nope" } }, {}, next);
    expect(next.calls[0].message).toContain("b");
  });

  // VACUITY PROBE: if uuidParams were a no-op that always called next(), the
  // rejection tests above would fail — but a reviewer cannot tell that from
  // reading them. This asserts the negative directly.
  it("VACUITY: isUuid actually discriminates rather than always returning true", () => {
    expect(isUuid(VALID)).toBe(true);
    expect(isUuid("nope")).toBe(false);
  });
});

describe("SEC-9.1 — validateBody", () => {
  const schema = z.object({ name: z.string().min(1) }).strict();

  it("replaces req.body with the parsed result", () => {
    const next = makeNext();
    const req = { body: { name: "  ok  " } };
    validateBody(z.object({ name: z.string().trim() }))(req, {}, next);
    expect(next.calls[0]).toBeUndefined();
    expect(req.body.name).toBe("ok");
  });

  it("rejects a wrong-typed field with a 400 rather than letting it reach the DB", () => {
    const next = makeNext();
    validateBody(schema)({ body: { name: 123 } }, {}, next);
    expect(next.calls[0].statusCode).toBe(400);
  });

  it("rejects unknown keys when the schema is strict", () => {
    const next = makeNext();
    validateBody(schema)({ body: { name: "x", extra: 1 } }, {}, next);
    expect(next.calls[0].statusCode).toBe(400);
  });

  it("treats a missing body as an empty object rather than crashing", () => {
    const next = makeNext();
    validateBody(schema)({}, {}, next);
    expect(next.calls[0].statusCode).toBe(400);
  });

  it("reports only the first issue, so the schema is not enumerated to the caller", () => {
    const next = makeNext();
    const multi = z.object({ a: z.string(), b: z.string(), c: z.string() });
    validateBody(multi)({ body: {} }, {}, next);
    const message = next.calls[0].message;
    // All three fields are invalid; only the first is named. Asserting the
    // absence of the others is the point - a full issue list would describe
    // the schema field by field to an unauthenticated caller.
    expect(message).toContain("a");
    expect(message).not.toContain("b:");
    expect(message).not.toContain("c:");
  });
});

describe("SEC-9.1 — toClientError mapping", () => {
  it("maps malformed JSON to 400, not 500 (the named finding)", () => {
    const err = Object.assign(new SyntaxError("Unexpected token }"), {
      type: "entity.parse.failed",
    });
    const mapped = toClientError(err);
    expect(mapped.statusCode).toBe(400);
  });

  it("never leaks the parse error's own message, which can quote the body", () => {
    const err = Object.assign(new SyntaxError('Unexpected token } in {"secret":"hunter2"}'), {
      type: "entity.parse.failed",
    });
    expect(toClientError(err).message).not.toContain("hunter2");
  });

  it("maps an oversized body to 413 (SEC-9.4's limit firing)", () => {
    expect(toClientError({ type: "entity.too.large" }).statusCode).toBe(413);
  });

  it("maps unsupported encoding to 415 and an aborted request to 400", () => {
    expect(toClientError({ type: "encoding.unsupported" }).statusCode).toBe(415);
    expect(toClientError({ type: "request.aborted" }).statusCode).toBe(400);
  });

  it("maps Postgres 22P02 (malformed literal) to 400", () => {
    expect(toClientError({ code: "22P02" }).statusCode).toBe(400);
  });

  it("maps 22003 / 22007 / 22008 / 54000 to 400", () => {
    for (const code of ["22003", "22007", "22008", "54000"]) {
      expect(toClientError({ code }).statusCode).toBe(400);
    }
  });

  // SEC-19.3 interaction: statement_timeout makes 57014 reachable for the
  // first time. Unmapped it would surface as a 500, i.e. the new safety
  // mechanism would look like a server bug the first time it worked.
  it("maps Postgres 57014 (statement_timeout fired) to 503, not 500", () => {
    const mapped = toClientError({ code: "57014" });
    expect(mapped.statusCode).toBe(503);
    expect(mapped.code).toBe("PROVIDER_UNAVAILABLE");
  });

  // VACUITY PROBES: the mapping must be an ALLOWLIST. If it returned an
  // AppError for anything with a `code`, genuine server faults would be
  // silently relabelled as the caller's fault and would stop being alerted on.
  it("VACUITY: returns null for an unrecognised Postgres code, preserving the 500", () => {
    expect(toClientError({ code: "23505" })).toBeNull(); // unique_violation
    expect(toClientError({ code: "42P01" })).toBeNull(); // undefined_table
    expect(toClientError({ code: "08006" })).toBeNull(); // connection_failure
  });

  it("VACUITY: returns null for a plain Error and for null/undefined", () => {
    expect(toClientError(new Error("boom"))).toBeNull();
    expect(toClientError(null)).toBeNull();
    expect(toClientError(undefined)).toBeNull();
  });

  it("VACUITY: returns null for an unknown body-parser type", () => {
    expect(toClientError({ type: "something.else" })).toBeNull();
  });
});
