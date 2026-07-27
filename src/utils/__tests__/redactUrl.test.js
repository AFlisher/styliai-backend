const {
  redactUrl,
  REDACTED_QUERY_PARAMS,
  REDACTION_PLACEHOLDER,
} = require("../redactUrl");

// SEC-16.1. The end-to-end proof that the real app stops leaking tokens lives
// in src/__tests__/requestLogRedaction.test.js; this file pins the pure
// function's contract, including the one that matters most operationally:
// redactUrl must never throw (morgan calls it from an onFinished callback,
// where an exception is an uncaught exception, not a failed request).

describe("redactUrl - redaction", () => {
  it("replaces the value of a token parameter", () => {
    expect(redactUrl("/api/auth/verify?token=super-secret")).toBe(
      "/api/auth/verify?token=[REDACTED]"
    );
  });

  it("does not leak the secret anywhere in the result", () => {
    const secret = "11111111-2222-3333-4444-555555555555";
    const out = redactUrl(`/api/auth/reset-password?token=${secret}`);

    expect(out).not.toContain(secret);
    expect(out).toContain(REDACTION_PLACEHOLDER);
  });

  it("uses a fixed placeholder that reveals neither length nor prefix", () => {
    const short = redactUrl("/x?token=a");
    const long = redactUrl(`/x?token=${"z".repeat(500)}`);

    expect(short).toBe(long);
  });

  it("redacts every occurrence of a repeated parameter", () => {
    expect(redactUrl("/x?token=one&token=two")).toBe(
      "/x?token=[REDACTED]&token=[REDACTED]"
    );
  });

  it("matches the parameter name case-insensitively", () => {
    expect(redactUrl("/x?TOKEN=secret")).toBe("/x?TOKEN=[REDACTED]");
    expect(redactUrl("/x?Token=secret")).toBe("/x?Token=[REDACTED]");
  });

  it("redacts a token that appears after other parameters", () => {
    expect(redactUrl("/x?a=1&token=secret&b=2")).toBe(
      "/x?a=1&token=[REDACTED]&b=2"
    );
  });

  it("redacts an empty token value without changing the shape of the URL", () => {
    expect(redactUrl("/x?token=")).toBe("/x?token=[REDACTED]");
  });
});

describe("redactUrl - preserved information", () => {
  it("returns a URL with no query string unchanged", () => {
    expect(redactUrl("/api/styles")).toBe("/api/styles");
  });

  it("leaves non-credential parameters byte-for-byte identical", () => {
    const url = "/api/styles?categoryId=cat-1&all=true&range=7d";
    expect(redactUrl(url)).toBe(url);
  });

  it("does not re-encode untouched values", () => {
    // URLSearchParams would normalise these; manual splitting must not.
    const url = "/x?q=a%20b&plus=a+b&raw=a:b/c";
    expect(redactUrl(url)).toBe(url);
  });

  it("keeps the path intact", () => {
    expect(redactUrl("/api/auth/verify?token=s")).toMatch(
      /^\/api\/auth\/verify\?/
    );
  });

  it("matches names exactly, so lookalike parameters stay readable", () => {
    // Substring matching would wrongly redact all of these.
    const url = "/x?tokenizer=abc&csrf_token_id=def&mytoken=ghi&token_type=jkl";
    expect(redactUrl(url)).toBe(url);
  });

  it("leaves a valueless parameter alone (there is no value to remove)", () => {
    expect(redactUrl("/x?token")).toBe("/x?token");
  });

  it("does not redact email addresses - that is SEC-16.2, not this finding", () => {
    const url = "/api/auth/status?email=user@example.com";
    expect(redactUrl(url)).toBe(url);
    expect(REDACTED_QUERY_PARAMS.has("email")).toBe(false);
  });
});

describe("redactUrl - totality (must never throw)", () => {
  // morgan invokes format tokens from an onFinished(res, ...) callback, outside
  // Express's error pipeline: a throw there crashes the process rather than
  // failing one request. Every one of these must return, not raise.
  const hostileInputs = [
    ["undefined", undefined],
    ["null", null],
    ["a number", 12345],
    ["an object", { toString: null }],
    ["an array", ["/x?token=a"]],
    ["a symbol-bearing object", Object.create(null)],
    ["an empty string", ""],
    ["a lone question mark", "?"],
    ["only separators", "/x?&&&"],
    ["a bare equals", "/x?="],
    ["stray percent signs", "/x?%%%"],
    ["a truncated escape", "/x?token=%E0%A4%A"],
    ["an unterminated pair", "/x?token"],
    ["a very long url", `/x?token=${"a".repeat(100000)}`],
    ["non-ascii", "/x?token=🔑&q=café"],
    ["newlines", "/x?token=a\nb\r\nc"],
    ["a null byte", "/x?token=a\u0000b"],
    ["nested question marks", "/x?token=a?b?c"],
  ];

  it.each(hostileInputs)("returns a string for %s", (_label, input) => {
    let result;
    expect(() => {
      result = redactUrl(input);
    }).not.toThrow();
    expect(typeof result).toBe("string");
  });

  it("never emits the secret for any hostile input that carries one", () => {
    // Asserted on the returned value rather than through a negated asymmetric
    // matcher, which can pass vacuously.
    const secret = "SENTINEL-SECRET-VALUE";
    const carriers = [
      `/x?token=${secret}`,
      `/x?token=${secret}&`,
      `/x?&token=${secret}`,
      `/x?token=${secret}#frag`,
      `/x??token=${secret}`,
      `/x?a=1&&token=${secret}&&b=2`,
      `/x?TOKEN=${secret}`,
    ];

    for (const url of carriers) {
      expect(redactUrl(url)).not.toContain(secret);
    }
  });

  it("fails closed rather than open when the query cannot be parsed", () => {
    // Force the catch path with an input whose split() misbehaves, and prove
    // the fallback drops the query string instead of returning it raw.
    const hostile = {
      indexOf: () => 2,
      slice: () => {
        throw new Error("boom");
      },
      split: (sep) => (sep === "?" ? ["/x", "token=SENTINEL"] : []),
    };

    let out;
    expect(() => {
      out = redactUrl(hostile);
    }).not.toThrow();
    expect(out).not.toContain("SENTINEL");
  });
});
