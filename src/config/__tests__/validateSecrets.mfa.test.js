// SEC-15.2: boot-time handling of MFA_ENCRYPTION_KEY.
//
// The asymmetry here is the point and is easy to get wrong in either
// direction: too strict takes production down for an unconfigured feature, too
// lax boots on a broken key and locks out every enrolled admin at next login.

const crypto = require("crypto");
const {
  checkMfaEncryptionKey,
  validateMfaEncryptionKey,
  MFA_ENCRYPTION_KEY_BYTES,
} = require("../validateSecrets");

const VALID = crypto.randomBytes(MFA_ENCRYPTION_KEY_BYTES).toString("base64");

beforeEach(() => {
  jest.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => console.warn.mockRestore());

describe("checkMfaEncryptionKey", () => {
  it("accepts a correctly sized key", () => {
    expect(checkMfaEncryptionKey({ MFA_ENCRYPTION_KEY: VALID })).toBeNull();
  });

  it.each([
    ["absent", {}],
    ["empty", { MFA_ENCRYPTION_KEY: "" }],
    ["too short", { MFA_ENCRYPTION_KEY: crypto.randomBytes(16).toString("base64") }],
    ["too long", { MFA_ENCRYPTION_KEY: crypto.randomBytes(48).toString("base64") }],
  ])("rejects a %s key", (_label, env) => {
    expect(checkMfaEncryptionKey(env)).toEqual(expect.any(String));
  });

  it("never echoes the key back in the problem description", () => {
    const env = { MFA_ENCRYPTION_KEY: crypto.randomBytes(16).toString("base64") };
    expect(checkMfaEncryptionKey(env)).not.toContain(env.MFA_ENCRYPTION_KEY);
  });
});

describe("validateMfaEncryptionKey", () => {
  it("passes with a valid key in production", () => {
    expect(
      validateMfaEncryptionKey({ NODE_ENV: "production", MFA_ENCRYPTION_KEY: VALID })
    ).toBe(true);
  });

  it("only WARNS on an absent key in production - MFA is opt-in, so this must not stop the boot", () => {
    // Refusing to boot here would take the whole API down for a feature no
    // admin has enrolled in. It cannot become a bypass either: the service
    // fails closed when it cannot decrypt a stored secret.
    expect(() => validateMfaEncryptionKey({ NODE_ENV: "production" })).not.toThrow();
    expect(console.warn).toHaveBeenCalled();
  });

  it("THROWS on a malformed key in production", () => {
    // A key that is present but wrong is a config error that would silently
    // lock out every enrolled admin at their next login.
    expect(() =>
      validateMfaEncryptionKey({
        NODE_ENV: "production",
        MFA_ENCRYPTION_KEY: "obviously-not-32-bytes",
      })
    ).toThrow(/MFA_ENCRYPTION_KEY/);
  });

  it("only warns outside production, malformed or not", () => {
    expect(() =>
      validateMfaEncryptionKey({ NODE_ENV: "development", MFA_ENCRYPTION_KEY: "short" })
    ).not.toThrow();
    expect(console.warn).toHaveBeenCalled();
  });
});
