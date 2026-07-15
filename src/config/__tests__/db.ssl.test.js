// Covers audit finding #1: the Postgres TLS configuration must support full
// certificate verification via DATABASE_CA_CERT, and must warn loudly when
// production runs without it.

const fs = require("fs");
const os = require("os");
const path = require("path");

const { buildSslConfig } = require("../db");

const FAKE_PEM = "-----BEGIN CERTIFICATE-----\nMIIFakeCert\n-----END CERTIFICATE-----\n";

describe("buildSslConfig", () => {
  it("verifies the server certificate when DATABASE_CA_CERT holds PEM content", () => {
    const ssl = buildSslConfig({ DATABASE_CA_CERT: FAKE_PEM, NODE_ENV: "production" });
    expect(ssl).toEqual({ ca: FAKE_PEM, rejectUnauthorized: true });
  });

  it("verifies the server certificate when DATABASE_CA_CERT is a file path", () => {
    const pemPath = path.join(os.tmpdir(), `styliai-test-ca-${process.pid}.pem`);
    fs.writeFileSync(pemPath, FAKE_PEM);
    try {
      const ssl = buildSslConfig({ DATABASE_CA_CERT: pemPath, NODE_ENV: "production" });
      expect(ssl).toEqual({ ca: FAKE_PEM, rejectUnauthorized: true });
    } finally {
      fs.unlinkSync(pemPath);
    }
  });

  it("falls back to unverified TLS in production without a CA, but warns", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ssl = buildSslConfig({ NODE_ENV: "production" });
      expect(ssl).toEqual({ rejectUnauthorized: false });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("DATABASE_CA_CERT"));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("disables SSL entirely outside production (local dev)", () => {
    expect(buildSslConfig({})).toBe(false);
  });
});
