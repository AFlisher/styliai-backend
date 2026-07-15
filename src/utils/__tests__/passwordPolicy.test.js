// Covers audit finding #8: one shared password policy (min 8 chars +
// upper/lower/digit/special) used by register, change-password, and
// reset-password.

const { passwordSchema, PASSWORD_POLICY_MESSAGE } = require("../passwordPolicy");

describe("passwordSchema", () => {
  it("accepts a password meeting every requirement", () => {
    expect(passwordSchema.safeParse("Str0ng!pass").success).toBe(true);
  });

  it.each([
    ["too short", "S1!a"],
    ["no uppercase", "weak1!password"],
    ["no lowercase", "WEAK1!PASSWORD"],
    ["no digit", "Weak!password"],
    ["no special character", "Weak1password"],
    ["old 6-char minimum no longer accepted", "abc123"],
  ])("rejects a password that is %s", (_label, value) => {
    const result = passwordSchema.safeParse(value);
    expect(result.success).toBe(false);
    expect(result.error.issues[0].message).toBe(PASSWORD_POLICY_MESSAGE);
  });
});
