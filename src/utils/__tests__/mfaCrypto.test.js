// SEC-15.2: the TOTP secret is symmetric - holding it is equivalent to holding
// the second factor forever - so these pin that it round-trips exactly, that a
// wrong key or a tampered ciphertext FAILS rather than degrading, and that the
// key material never appears in an error message.

const crypto = require("crypto");
const {
  loadKey,
  encryptSecret,
  decryptSecret,
  KEY_BYTES,
  FORMAT_VERSION,
} = require("../mfaCrypto");

const KEY_A = crypto.randomBytes(KEY_BYTES).toString("base64");
const KEY_B = crypto.randomBytes(KEY_BYTES).toString("base64");
const envA = { MFA_ENCRYPTION_KEY: KEY_A };
const envB = { MFA_ENCRYPTION_KEY: KEY_B };

const SECRET = "JBSWY3DPEHPK3PXP";

describe("loadKey", () => {
  it("accepts a 32-byte base64 key", () => {
    expect(loadKey(envA)).toHaveLength(KEY_BYTES);
  });

  it.each([
    ["missing", {}],
    ["empty", { MFA_ENCRYPTION_KEY: "" }],
    ["whitespace only", { MFA_ENCRYPTION_KEY: "   " }],
    ["too short", { MFA_ENCRYPTION_KEY: crypto.randomBytes(16).toString("base64") }],
    ["too long", { MFA_ENCRYPTION_KEY: crypto.randomBytes(64).toString("base64") }],
  ])("rejects a %s key", (_label, env) => {
    expect(() => loadKey(env)).toThrow();
  });

  it("never puts the key material in the error message", () => {
    // These messages reach logs on the failure path.
    const env = { MFA_ENCRYPTION_KEY: crypto.randomBytes(16).toString("base64") };
    try {
      loadKey(env);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err.message).not.toContain(env.MFA_ENCRYPTION_KEY);
    }
  });
});

describe("round trip", () => {
  it("decrypts back to the original secret", () => {
    expect(decryptSecret(encryptSecret(SECRET, envA), envA)).toBe(SECRET);
  });

  it("never emits the plaintext secret in the stored value", () => {
    const stored = encryptSecret(SECRET, envA);
    expect(stored).not.toContain(SECRET);
    expect(stored.startsWith(FORMAT_VERSION + ".")).toBe(true);
  });

  it("produces a different ciphertext every time (random IV)", () => {
    const a = encryptSecret(SECRET, envA);
    const b = encryptSecret(SECRET, envA);

    // Equal ciphertexts would leak that two admins share a secret.
    expect(a).not.toBe(b);
    expect(decryptSecret(a, envA)).toBe(decryptSecret(b, envA));
  });
});

describe("failure modes must fail, not degrade", () => {
  it("refuses to decrypt under a different key", () => {
    const stored = encryptSecret(SECRET, envA);
    // The key-rotation case: a mismatch has to be loud. Silently returning
    // something falsy here would let a mis-set env var read as "this admin has
    // no second factor".
    expect(() => decryptSecret(stored, envB)).toThrow();
  });

  it("detects a tampered ciphertext (GCM auth tag)", () => {
    const stored = encryptSecret(SECRET, envA);
    const parts = stored.split(".");
    const raw = Buffer.from(parts[3], "base64");
    raw[0] ^= 0xff;
    parts[3] = raw.toString("base64");

    expect(() => decryptSecret(parts.join("."), envA)).toThrow();
  });

  it("detects a tampered authentication tag", () => {
    const parts = encryptSecret(SECRET, envA).split(".");
    const tag = Buffer.from(parts[2], "base64");
    tag[0] ^= 0xff;
    parts[2] = tag.toString("base64");

    expect(() => decryptSecret(parts.join("."), envA)).toThrow();
  });

  it.each([
    ["empty", ""],
    ["not versioned", "abc.def.ghi"],
    ["wrong version", "v2.a.b.c"],
    ["too few parts", "v1.a.b"],
    ["too many parts", "v1.a.b.c.d"],
    ["malformed iv", "v1.AAAA.AAAA.AAAA"],
    ["plaintext passthrough attempt", SECRET],
  ])("rejects a %s stored value", (_label, stored) => {
    expect(() => decryptSecret(stored, envA)).toThrow();
  });

  it.each([[null], [undefined], [42], [{}]])("rejects non-string input %p", (input) => {
    expect(() => decryptSecret(input, envA)).toThrow();
    expect(() => encryptSecret(input, envA)).toThrow();
  });
});
