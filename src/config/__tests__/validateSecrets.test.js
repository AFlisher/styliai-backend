// Covers SEC-17.1: ADMIN_JWT_SECRET must clear an objective quality floor at
// boot - present, long enough, and not a placeholder - failing closed in
// production and warning only outside it.

const {
  checkAdminJwtSecret,
  validateAdminJwtSecret,
  MIN_ADMIN_JWT_SECRET_BYTES
} = require("../validateSecrets");

// 64 characters, the shape of `openssl rand -base64 48`.
const STRONG_SECRET = "hQ2m8VtLp0RzXcN7jWbYs4KdFgAe1UoIrTvBnMxZqPwCyJhSlEuGkD3aOfV6i5R9";

describe("checkAdminJwtSecret", () => {
  it("accepts a secret that clears the length floor", () => {
    expect(checkAdminJwtSecret({ ADMIN_JWT_SECRET: STRONG_SECRET })).toBeNull();
  });

  it("rejects an unset secret", () => {
    expect(checkAdminJwtSecret({})).toMatch(/not set/i);
  });

  it("rejects an empty or whitespace-only secret", () => {
    expect(checkAdminJwtSecret({ ADMIN_JWT_SECRET: "" })).toMatch(/not set/i);
    expect(checkAdminJwtSecret({ ADMIN_JWT_SECRET: "   " })).toMatch(/not set/i);
  });

  it("rejects a secret below the minimum byte length", () => {
    const short = "a".repeat(MIN_ADMIN_JWT_SECRET_BYTES - 1);
    expect(checkAdminJwtSecret({ ADMIN_JWT_SECRET: short })).toMatch(/too short/i);
  });

  it("accepts a secret exactly at the minimum byte length", () => {
    const exact = "a".repeat(MIN_ADMIN_JWT_SECRET_BYTES);
    expect(checkAdminJwtSecret({ ADMIN_JWT_SECRET: exact })).toBeNull();
  });

  it("measures length in UTF-8 bytes, not characters", () => {
    // 20 multi-byte characters: under the floor by character count, over it by
    // byte count. The byte measure is the one that matters for key material.
    const multibyte = "é".repeat(20); // 40 bytes
    expect(multibyte.length).toBeLessThan(MIN_ADMIN_JWT_SECRET_BYTES);
    expect(checkAdminJwtSecret({ ADMIN_JWT_SECRET: multibyte })).toBeNull();
  });

  it.each([
    "changeme",
    "CHANGEME",
    "  changeme  ",
    "default",
    "test",
    "your-secret-here",
    "password"
  ])("rejects the placeholder value %p", (placeholder) => {
    expect(checkAdminJwtSecret({ ADMIN_JWT_SECRET: placeholder })).toMatch(
      /placeholder/i
    );
  });

  it("matches placeholders exactly, so a random secret containing one is fine", () => {
    // Substring matching would reject this legitimate secret; exact matching
    // must not.
    const containsWord = `${STRONG_SECRET}changeme`;
    expect(checkAdminJwtSecret({ ADMIN_JWT_SECRET: containsWord })).toBeNull();
  });

  it("never echoes the secret in the problem message", () => {
    const short = "supersecretvalue";
    const problem = checkAdminJwtSecret({ ADMIN_JWT_SECRET: short });
    expect(problem).not.toContain(short);
  });
});

describe("validateAdminJwtSecret", () => {
  it("passes silently on a good secret in production", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ok = validateAdminJwtSecret({
        ADMIN_JWT_SECRET: STRONG_SECRET,
        NODE_ENV: "production"
      });
      expect(ok).toBe(true);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("fails closed in production on a weak secret", () => {
    expect(() =>
      validateAdminJwtSecret({ ADMIN_JWT_SECRET: "short", NODE_ENV: "production" })
    ).toThrow(/ADMIN_JWT_SECRET/);
  });

  it("fails closed in production when the secret is missing entirely", () => {
    expect(() => validateAdminJwtSecret({ NODE_ENV: "production" })).toThrow(
      /not set/i
    );
  });

  it("only warns outside production", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ok = validateAdminJwtSecret({
        ADMIN_JWT_SECRET: "short",
        NODE_ENV: "development"
      });
      expect(ok).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("ADMIN_JWT_SECRET"));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("points at the generation command when it rejects a secret", () => {
    expect(() =>
      validateAdminJwtSecret({ ADMIN_JWT_SECRET: "short", NODE_ENV: "production" })
    ).toThrow(/openssl rand -base64 48/);
  });

  it("does not leak the rejected secret into the thrown message", () => {
    // Asserted on the caught message rather than via
    // `toThrow(expect.not.stringContaining(...))`, which passes vacuously.
    const weak = "tinysecret";
    let caught;
    try {
      validateAdminJwtSecret({ ADMIN_JWT_SECRET: weak, NODE_ENV: "production" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.message).not.toContain(weak);
  });
});
