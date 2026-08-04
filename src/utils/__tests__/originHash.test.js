const { originHashFor, hashIp, normalizeIp, resetSaltCache, isEnabled } =
  require("../originHash");

const SALT = "a-test-salt-at-least-16-chars";
const env = (over = {}) => ({ IP_HASH_SALT: SALT, ...over });

beforeEach(() => resetSaltCache());

describe("SEC-18.3 — normalisation", () => {
  // Without this, the SAME machine hashes differently depending on whether the
  // socket was dual-stack - so correlation would silently fail for exactly the
  // clients it most needs to group.
  it("treats an IPv4-mapped IPv6 address as its IPv4 form", () => {
    expect(hashIp("::ffff:1.2.3.4", env())).toBe(hashIp("1.2.3.4", env()));
  });

  it("strips a trailing port from IPv4 but not from IPv6", () => {
    expect(normalizeIp("1.2.3.4:5678")).toBe("1.2.3.4");
    expect(normalizeIp("2001:db8::1")).toBe("2001:db8::1");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(hashIp("  2001:DB8::1  ", env())).toBe(hashIp("2001:db8::1", env()));
  });

  it("returns null for unusable input rather than hashing a placeholder", () => {
    for (const v of [null, undefined, "", "   ", 42, {}]) {
      expect(normalizeIp(v)).toBeNull();
    }
  });
});

describe("SEC-18.3 — the hash is a correlation key, not stored PII", () => {
  it("is stable for one address", () => {
    expect(hashIp("203.0.113.7", env())).toBe(hashIp("203.0.113.7", env()));
  });

  it("differs between addresses", () => {
    expect(hashIp("203.0.113.7", env())).not.toBe(hashIp("203.0.113.8", env()));
  });

  it("never contains the address it was derived from", () => {
    const h = hashIp("203.0.113.7", env());
    expect(h).not.toContain("203");
    expect(h).not.toContain("113");
  });

  // THE point of using HMAC rather than a plain hash. The IPv4 space is 2^32;
  // an unkeyed digest of an IP is reversible by enumeration in minutes, which
  // would make this "the IP with extra steps" rather than a one-way key.
  it("is keyed — a different salt produces a different hash for the same IP", () => {
    const a = hashIp("203.0.113.7", env());
    resetSaltCache();
    const b = hashIp("203.0.113.7", env({ IP_HASH_SALT: "a-different-salt-16chars" }));
    expect(a).not.toBe(b);
  });

  it("is 128 bits of hex", () => {
    expect(hashIp("203.0.113.7", env())).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("SEC-18.3 — a missing salt DISABLES correlation, never fakes it", () => {
  // The two rejected alternatives, asserted so nobody reintroduces them:
  // a random per-boot salt would appear to work while grouping nothing, and a
  // constant fallback would turn this back into a reversible store of the IP.
  it("returns null when the salt is unset", () => {
    expect(hashIp("203.0.113.7", {})).toBeNull();
    expect(isEnabled({})).toBe(false);
  });

  it("returns null when the salt is too short to be a real key", () => {
    expect(hashIp("203.0.113.7", { IP_HASH_SALT: "short" })).toBeNull();
  });

  it("warns once, so a misconfiguration is visible but does not flood", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    hashIp("203.0.113.7", {});
    hashIp("203.0.113.8", {});
    hashIp("203.0.113.9", {});
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("SEC-18.3 — originHashFor(req)", () => {
  it("hashes Express's resolved client address", () => {
    const h = originHashFor({ ip: "203.0.113.7" }, env());
    expect(h).toBe(hashIp("203.0.113.7", env()));
  });

  it("returns null when there is no resolvable address", () => {
    expect(originHashFor({}, env())).toBeNull();
    expect(originHashFor({ ip: "" }, env())).toBeNull();
    expect(originHashFor(null, env())).toBeNull();
  });

  // VACUITY PROBES ---------------------------------------------------------
  // If hashIp returned a constant, every "shares an origin" detector would
  // group the entire user base into one gigantic false positive.
  it("VACUITY: is not a constant across inputs", () => {
    const seen = new Set(
      ["1.1.1.1", "2.2.2.2", "3.3.3.3", "2001:db8::1"].map((ip) => hashIp(ip, env()))
    );
    expect(seen.size).toBe(4);
  });

  it("VACUITY: identical inputs really do collide (grouping works at all)", () => {
    expect(hashIp("8.8.8.8", env())).toBe(hashIp("8.8.8.8", env()));
  });
});
