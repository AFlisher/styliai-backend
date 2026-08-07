// System Health module: buildEnvSummary() must never expose a credential
// value, only whether one is configured - and must reuse abusePolicy /
// playIntegrityConfig's already-parsed settings rather than re-deriving them.

const { buildEnvSummary } = require("../envSummary");

describe("buildEnvSummary", () => {
  it("exposes safe, non-sensitive values directly", () => {
    const summary = buildEnvSummary({ NODE_ENV: "production", IMAGE_PROVIDER: "fal", LOG_LEVEL: "info" });

    expect(summary.nodeEnv).toBe("production");
    expect(summary.imageProvider).toBe("fal");
    expect(summary.logLevel).toBe("info");
  });

  it("never includes any credential-shaped value, only a configured boolean", () => {
    const summary = buildEnvSummary({
      RESEND_API_KEY: "re_live_SENTINEL_SECRET",
      STABILITY_API_KEY: "sk-SENTINEL_SECRET",
      GEMINI_API_KEY: "SENTINEL_SECRET",
      FAL_API_KEY: "SENTINEL_SECRET",
      TURNSTILE_SECRET_KEY: "SENTINEL_SECRET",
      DATABASE_URL: "postgres://user:SENTINEL_SECRET@host/db",
      ADMIN_JWT_SECRET: "SENTINEL_SECRET",
    });

    expect(JSON.stringify(summary)).not.toContain("SENTINEL_SECRET");
    expect(summary.servicesConfigured).toEqual({
      email: true,
      stabilityAI: true,
      gemini: true,
      fal: true,
      turnstile: true,
    });
    // DATABASE_URL / ADMIN_JWT_SECRET have no field in the summary at all -
    // not even a configured boolean. Confirmed by the full-string check above
    // and by there being no key of that name anywhere in the output.
    expect(summary).not.toHaveProperty("databaseUrl");
    expect(summary).not.toHaveProperty("adminJwtSecret");
  });

  it("reports a key as unconfigured when absent or a YOUR_* placeholder", () => {
    const absent = buildEnvSummary({});
    expect(absent.servicesConfigured.email).toBe(false);

    const placeholder = buildEnvSummary({ RESEND_API_KEY: "YOUR_RESEND_API_KEY" });
    expect(placeholder.servicesConfigured.email).toBe(false);
  });

  it("sources abuse-detection settings from abusePolicy.policy rather than re-reading env", () => {
    const { policy } = require("../abusePolicy");

    const summary = buildEnvSummary({});

    expect(summary.abuseDetection).toEqual({
      sweepEnabled: policy.sweepEnabled,
      sweepIntervalMs: policy.sweepIntervalMs,
      autoSuspendEnabled: policy.enforcement.autoSuspendEnabled,
    });
  });

  it("sources Play Integrity settings from playIntegrityConfig.config rather than re-reading env", () => {
    const { config, isConfigured } = require("../playIntegrityConfig");

    const summary = buildEnvSummary({});

    expect(summary.playIntegrity).toEqual({
      enforcement: config.enforcement,
      sweepIntervalMs: config.sweepIntervalMs,
      configured: isConfigured(),
    });
  });

  it("defaults nodeEnv/imageProvider/logLevel to null when absent", () => {
    const summary = buildEnvSummary({});

    expect(summary.nodeEnv).toBeNull();
    expect(summary.imageProvider).toBeNull();
    expect(summary.logLevel).toBeNull();
  });
});
