const {
  isDisposableEmail,
  verifyCaptcha,
  captchaEnabled,
  signupControls,
  resetDomainCache,
} = require("../signupControls");

beforeEach(() => {
  resetDomainCache();
  jest.restoreAllMocks();
});

describe("SEC-18.4 — disposable email detection", () => {
  it.each([
    "a@mailinator.com",
    "b@guerrillamail.com",
    "c@10minutemail.com",
    "d@yopmail.com",
    "E@MAILINATOR.COM",
    "  f@trashmail.com  ".trim(),
  ])("rejects %s", (email) => {
    expect(isDisposableEmail(email)).toBe(true);
  });

  it("matches subdomains, which is how these services hand out addresses", () => {
    expect(isDisposableEmail("a@inbox.mailinator.com")).toBe(true);
    expect(isDisposableEmail("a@x.y.guerrillamail.com")).toBe(true);
  });

  // FALSE POSITIVES: the check must not touch real providers.
  it.each([
    "user@gmail.com",
    "user@outlook.com",
    "user@proton.me",
    "user@company.co.uk",
    "user@university.edu",
    // A domain that merely CONTAINS a blocked name must not match.
    "user@notmailinator.com",
    "user@mailinator.com.mycompany.net",
  ])("accepts %s", (email) => {
    expect(isDisposableEmail(email)).toBe(false);
  });

  it("never throws on malformed input — format is the schema's job, not this check's", () => {
    for (const v of [null, undefined, 42, {}, "", "no-at-sign", "@", "a@"]) {
      expect(() => isDisposableEmail(v)).not.toThrow();
      expect(isDisposableEmail(v)).toBe(false);
    }
  });

  it("accepts extra domains from configuration without a deploy", () => {
    expect(isDisposableEmail("a@evil.test", { DISPOSABLE_EMAIL_DOMAINS: "evil.test" })).toBe(true);
  });

  // VACUITY: a checker that returned true for everything would pass every
  // rejection test while blocking the entire signup funnel.
  it("VACUITY: discriminates rather than blanket-rejecting", () => {
    expect(isDisposableEmail("a@mailinator.com")).toBe(true);
    expect(isDisposableEmail("a@gmail.com")).toBe(false);
  });
});

describe("SEC-18.4 — CAPTCHA is inert until configured", () => {
  it("is disabled with no secret key", () => {
    expect(captchaEnabled({})).toBe(false);
  });

  it("skips verification entirely when disabled", async () => {
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue({ ok: true, json: async () => ({}) });
    const result = await verifyCaptcha("anything", { env: {} });
    expect(result).toEqual({ ok: true, skipped: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("is enabled once a secret is present", () => {
    expect(captchaEnabled({ TURNSTILE_SECRET_KEY: "sk" })).toBe(true);
  });
});

describe("SEC-18.4 — CAPTCHA verdicts vs infrastructure failures", () => {
  const env = { TURNSTILE_SECRET_KEY: "sk" };

  it("accepts a token Cloudflare approves", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
    await expect(verifyCaptcha("tok", { env })).resolves.toMatchObject({ ok: true, skipped: false });
  });

  // A real answer of "no" is honoured - this is the fail-CLOSED half.
  it("rejects a token Cloudflare refuses", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ success: false, "error-codes": ["invalid-input-response"] }),
    });
    const r = await verifyCaptcha("tok", { env });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("rejected");
  });

  it("rejects a missing token without calling out", async () => {
    const fetchSpy = jest.spyOn(global, "fetch");
    const r = await verifyCaptcha("", { env });
    expect(r.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // The fail-OPEN half, deliberately distinct from a verdict: a Cloudflare
  // outage must not close the signup funnel worldwide, and reverting to the
  // pre-Phase-8 posture (rate limiter only) on a Low, conditional finding is
  // the better of the two failure modes.
  it("fails OPEN when the verifier is unreachable", async () => {
    jest.spyOn(global, "fetch").mockRejectedValue(new Error("network down"));
    await expect(verifyCaptcha("tok", { env })).resolves.toMatchObject({ ok: true, skipped: true });
  });

  it("fails OPEN on a non-200 from the verifier", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue({ ok: false, json: async () => ({}) });
    await expect(verifyCaptcha("tok", { env })).resolves.toMatchObject({ ok: true, skipped: true });
  });

  it("never returns the verifier's whole response body", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ success: false, "error-codes": ["bad"], secret_echo: "sk-leaked" }),
    });
    const r = await verifyCaptcha("tok", { env });
    expect(JSON.stringify(r)).not.toContain("sk-leaked");
  });
});

describe("SEC-18.4 — the middleware", () => {
  function mk(body = {}) {
    const req = { body, ip: "1.2.3.4", headers: {}, id: "r1", method: "POST", originalUrl: "/api/auth/register" };
    const res = {
      statusCode: 200,
      body: undefined,
      status: jest.fn(function (c) { res.statusCode = c; return res; }),
      json: jest.fn(function (b) { res.body = b; return res; }),
    };
    return { req, res, next: jest.fn() };
  }

  it("blocks a disposable address with 400", async () => {
    const { req, res, next } = mk({ email: "x@mailinator.com" });
    await signupControls({ requireCaptcha: false })(req, res, next);
    expect(res.statusCode).toBe(400);
    expect(next).not.toHaveBeenCalled();
  });

  it("lets a real address through", async () => {
    const { req, res, next } = mk({ email: "x@gmail.com" });
    await signupControls({ requireCaptcha: false })(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it("passes through when the CAPTCHA is unconfigured, so shipping changes nothing", async () => {
    const { req, res, next } = mk({ email: "x@gmail.com" });
    await signupControls()(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it("tolerates a missing body", async () => {
    const { req, res, next } = mk();
    req.body = undefined;
    await signupControls({ requireCaptcha: false })(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it("does not disclose whether the account exists", async () => {
    const { req, res } = mk({ email: "x@mailinator.com" });
    await signupControls({ requireCaptcha: false })(req, res, jest.fn());
    const text = JSON.stringify(res.body).toLowerCase();
    expect(text).not.toContain("exists");
    expect(text).not.toContain("registered");
  });
});
