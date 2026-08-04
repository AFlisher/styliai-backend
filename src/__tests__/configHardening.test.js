"use strict";

/**
 * Phase 6 — configuration and secret hygiene, asserted rather than assumed.
 *
 * Two different failure modes are covered here. One is a secret reaching the
 * repository, which is caught by scanning the tracked tree. The other is a
 * boot-time guard silently not guarding, which is only visible if the guard is
 * driven with the values it exists to reject.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const REPO_ROOT = path.join(__dirname, "..", "..");

/** Tracked files only. An untracked local .env is fine; a committed one is not. */
function trackedFiles() {
  return execFileSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

describe("no secret is committed", () => {
  const files = trackedFiles();

  it("tracks no .env file", () => {
    // A local .env is expected and gitignored. A tracked one is a live leak of
    // every credential the service holds.
    const env = files.filter((f) => /(^|\/)\.env($|\.)/.test(f) && !f.endsWith(".example"));

    expect(env).toEqual([]);
  });

  it("tracks no keystore or private key material", () => {
    const keys = files.filter((f) => /\.(jks|keystore|p12|pfx|pem|key)$/i.test(f));

    expect(keys).toEqual([]);
  });

  it("contains no credential-shaped literal in tracked source", () => {
    // Patterns, not entropy: this is a floor under gitleaks (which runs in CI
    // over the full history), not a replacement for it.
    const patterns = [
      /-----BEGIN (RSA |EC )?PRIVATE KEY-----/,
      /\bsk_live_[A-Za-z0-9]{10,}/,
      /\bsb_secret_[A-Za-z0-9]{10,}/,
      /\bAIza[A-Za-z0-9_\-]{35}\b/,
    ];

    const offenders = [];
    for (const file of files) {
      if (!/\.(js|json|ts|md|yml|yaml|kts|gradle)$/.test(file)) continue;
      if (file.includes("__tests__") || file.includes("package-lock.json")) continue;

      const full = path.join(REPO_ROOT, file);
      if (!fs.existsSync(full)) continue;
      const source = fs.readFileSync(full, "utf8");

      for (const pattern of patterns) {
        if (pattern.test(source)) offenders.push(`${file} :: ${pattern}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("documents every environment variable the code reads", () => {
    // A variable that is read but undocumented is one an operator will not set,
    // and the failure surfaces in production rather than at deploy time.
    const docs = fs.readFileSync(path.join(REPO_ROOT, "SECURITY_OPERATIONS.md"), "utf8");

    const referenced = new Set();
    for (const file of files) {
      if (!file.startsWith("src/") || !file.endsWith(".js")) continue;
      if (file.includes("__tests__")) continue;
      const source = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
      for (const match of source.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
        referenced.add(match[1]);
      }
      // Phase 7: config helpers that read the environment INDIRECTLY.
      //
      // `process.env.X` was the only pattern this scanned, so a variable read
      // through a helper that takes an `env` object - config/db.js's
      // poolSetting(name, fallback, env) reaching env[name] - was invisible to
      // it. That is not a hypothetical: the SEC-19.3 pool bounds are all read
      // that way, and every one of them would have shipped undocumented while
      // this test stayed green. Matching the quoted literal passed to those
      // helpers restores the completeness guarantee for the indirect form.
      for (const match of source.matchAll(
        /(?:poolSetting|envFlag|envInt)\(\s*['"]([A-Z0-9_]+)['"]/g
      )) {
        referenced.add(match[1]);
      }
      // Bare `env.X` destructured off an injected environment object.
      for (const match of source.matchAll(/\benv\.([A-Z][A-Z0-9_]{2,})\b/g)) {
        referenced.add(match[1]);
      }
    }

    const undocumented = [...referenced].filter((name) => !docs.includes(name));

    expect(undocumented).toEqual([]);
  });
});

describe("secret validation refuses weak production configuration", () => {
  const {
    validateAdminJwtSecret,
    PLACEHOLDER_SECRETS,
    MIN_ADMIN_JWT_SECRET_BYTES,
  } = require("../config/validateSecrets");

  const strong = "N0t-A-Real-Secret-Just-Long-Enough-For-The-Boot-Check";

  it("accepts a strong secret in production", () => {
    expect(() =>
      validateAdminJwtSecret({ NODE_ENV: "production", ADMIN_JWT_SECRET: strong })
    ).not.toThrow();
  });

  it("refuses to boot with no admin secret in production", () => {
    expect(() => validateAdminJwtSecret({ NODE_ENV: "production" })).toThrow();
  });

  it("refuses a secret shorter than the minimum", () => {
    const short = "x".repeat(MIN_ADMIN_JWT_SECRET_BYTES - 1);

    expect(() =>
      validateAdminJwtSecret({ NODE_ENV: "production", ADMIN_JWT_SECRET: short })
    ).toThrow();
  });

  it("refuses every known placeholder, however long", () => {
    // Length alone is not strength: a long, well-known placeholder passes a
    // byte count and protects nothing.
    for (const placeholder of PLACEHOLDER_SECRETS) {
      expect(() =>
        validateAdminJwtSecret({ NODE_ENV: "production", ADMIN_JWT_SECRET: placeholder })
      ).toThrow();
    }
  });

  it("warns rather than throws outside production", () => {
    // A developer must be able to boot with a throwaway secret; a production
    // deploy must not.
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

    expect(() =>
      validateAdminJwtSecret({ NODE_ENV: "development", ADMIN_JWT_SECRET: "short" })
    ).not.toThrow();
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
  });
});
