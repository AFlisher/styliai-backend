"use strict";

/**
 * Phase 6 — endpoint-specific limits, environment overrides, and the ordering
 * that makes an identity-keyed limiter actually key on identity.
 *
 * The last of those is the one that bites silently: express-rate-limit does not
 * complain when `req.user` is missing at key time, it just falls back to the IP.
 * The limiter still works, still returns 429s, and quietly shares one budget
 * across every user behind a NAT. Nothing about that is visible without a test.
 */

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  jest.resetModules();
});

function loadLimiters() {
  jest.resetModules();
  return require("../rateLimiters");
}

describe("endpoint-specific limits", () => {
  it("gives the avatar endpoint a budget strictly tighter than the generic one", () => {
    // The endpoint decodes and re-encodes every image, so it must not share a
    // budget sized for cheap JSON reads.
    //
    // Asserted as a relationship, not as "these two differ": a vacuity probe
    // that changed the avatar budget to 60/minute - i.e. exactly the shape of
    // the generic limiter it is supposed to be tighter than - left the old
    // "not.toEqual" assertion green, because any different number satisfied it.
    const { LIMIT_VALUES } = loadLimiters();
    const avatar = LIMIT_VALUES.avatarUploadLimiter;
    const generic = LIMIT_VALUES.userDataLimiter;

    expect(avatar).toBeDefined();
    // Fewer requests allowed, over a longer window: both directions matter,
    // since either alone can be defeated by moving the other.
    expect(avatar.limit).toBeLessThan(generic.limit);
    expect(avatar.windowMs).toBeGreaterThan(generic.windowMs);
  });

  it("keeps every sensitive endpoint on its own limiter", () => {
    const { LIMIT_VALUES } = loadLimiters();

    for (const name of [
      "loginLimiter",
      "registerLimiter",
      "forgotPasswordLimiter",
      "resetPasswordLimiter",
      "emailVerificationLimiter",
      "avatarUploadLimiter",
      "generationLimiter",
    ]) {
      expect(LIMIT_VALUES[name]).toBeDefined();
      expect(LIMIT_VALUES[name].limit).toBeGreaterThan(0);
      expect(LIMIT_VALUES[name].windowMs).toBeGreaterThan(0);
    }
  });

  it("leaves headroom for a real user on every human-facing limiter", () => {
    // The failure mode this guards against is locking legitimate users out. A
    // person mistypes a password a few times, taps resend once or twice, and
    // changes their avatar a handful of times - never dozens.
    const { LIMIT_VALUES } = loadLimiters();

    expect(LIMIT_VALUES.loginLimiter.limit).toBeGreaterThanOrEqual(5);
    expect(LIMIT_VALUES.registerLimiter.limit).toBeGreaterThanOrEqual(3);
    expect(LIMIT_VALUES.forgotPasswordLimiter.limit).toBeGreaterThanOrEqual(3);
    expect(LIMIT_VALUES.avatarUploadLimiter.limit).toBeGreaterThanOrEqual(5);
  });

  it("keeps brute-forceable endpoints tight enough to matter", () => {
    const { LIMIT_VALUES } = loadLimiters();

    expect(LIMIT_VALUES.loginLimiter.limit).toBeLessThanOrEqual(20);
    expect(LIMIT_VALUES.adminLoginLimiter.limit).toBeLessThanOrEqual(20);
  });
});

describe("Retry-After and the 429 body", () => {
  it("enables the standard headers, which is what carries Retry-After", () => {
    // Asserted on the shared base rather than per limiter: it is set once, and
    // a limiter that opted out would be the anomaly.
    const { BASE_OPTIONS } = loadLimiters();

    expect(BASE_OPTIONS.standardHeaders).toBe(true);
    expect(BASE_OPTIONS.legacyHeaders).toBe(false);
  });
});

describe("environment overrides", () => {
  it("accepts a positive override for a limit", () => {
    process.env.RATE_LIMIT_LOGIN_LIMITER_LIMIT = "3";

    expect(loadLimiters().LIMIT_VALUES.loginLimiter.limit).toBe(3);
  });

  it("accepts a positive override for a window", () => {
    process.env.RATE_LIMIT_LOGIN_LIMITER_WINDOW_MS = "60000";

    expect(loadLimiters().LIMIT_VALUES.loginLimiter.windowMs).toBe(60000);
  });

  it("derives the variable name from the limiter name", () => {
    process.env.RATE_LIMIT_AVATAR_UPLOAD_LIMITER_LIMIT = "2";

    expect(loadLimiters().LIMIT_VALUES.avatarUploadLimiter.limit).toBe(2);
  });

  it("ignores a zero override instead of locking everyone out", () => {
    // A limit of 0 rejects every request forever. A typo in an env var must
    // not be able to take an endpoint down.
    process.env.RATE_LIMIT_LOGIN_LIMITER_LIMIT = "0";
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

    const { LIMIT_VALUES } = loadLimiters();

    expect(LIMIT_VALUES.loginLimiter.limit).toBe(10);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it.each([["negative", "-5"], ["not a number", "abc"], ["empty", ""]])(
    "ignores a %s override and keeps the safe default",
    (_label, value) => {
      process.env.RATE_LIMIT_LOGIN_LIMITER_LIMIT = value;
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

      expect(loadLimiters().LIMIT_VALUES.loginLimiter.limit).toBe(10);

      warn.mockRestore();
    }
  );

  it("does not stop the app booting on a bad override", () => {
    process.env.RATE_LIMIT_LOGIN_LIMITER_LIMIT = "not-a-number";
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

    expect(() => loadLimiters()).not.toThrow();

    warn.mockRestore();
  });

  it("floors a fractional limit rather than passing it through", () => {
    process.env.RATE_LIMIT_LOGIN_LIMITER_LIMIT = "7.9";

    expect(loadLimiters().LIMIT_VALUES.loginLimiter.limit).toBe(7);
  });
});

describe("identity-keyed limiters run after authentication", () => {
  const routeFiles = {
    "profileRoutes.js": require("fs").readFileSync(
      require("path").join(__dirname, "../../routes/profileRoutes.js"),
      "utf8"
    ),
  };

  it("puts authMiddleware before the avatar limiter", () => {
    // If the limiter runs first, req.user does not exist when the key is
    // computed and it silently falls back to the IP - one shared budget of 10
    // for every user behind a NAT. Nothing about that failure is visible at
    // runtime, which is why it is asserted structurally.
    const source = routeFiles["profileRoutes.js"];
    const authAt = source.indexOf("authMiddleware,");
    const limiterAt = source.indexOf("avatarUploadLimiter,");

    expect(authAt).toBeGreaterThan(-1);
    expect(limiterAt).toBeGreaterThan(-1);
    expect(authAt).toBeLessThan(limiterAt);
  });

  it("still puts authentication before the multipart parser", () => {
    // Unchanged from R-2 phase 1: an unauthenticated caller must be refused
    // before multer buffers up to 10 MiB into memory.
    const source = routeFiles["profileRoutes.js"];

    expect(source.indexOf("authMiddleware,")).toBeLessThan(source.indexOf("upload.single("));
  });
});
