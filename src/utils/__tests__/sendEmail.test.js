// SEC-16.1: the un-configured-API-key branch must not print the email body.
// The verification and reset templates embed a live single-use recovery token
// in their link, so logging the body would reopen the exact leak the request
// logger redaction closes - and this branch is fail-open, reached whenever
// RESEND_API_KEY is missing or left as a `YOUR_*` placeholder.

const sendEmail = require("../sendEmail");

describe("sendEmail - simulated branch does not log recovery tokens (SEC-16.1)", () => {
  const originalKey = process.env.RESEND_API_KEY;
  let logSpy;
  let warnSpy;

  beforeEach(() => {
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    if (originalKey === undefined) {
      delete process.env.RESEND_API_KEY;
    } else {
      process.env.RESEND_API_KEY = originalKey;
    }
  });

  const TOKEN = "11111111-2222-3333-4444-555555555555";
  const HTML = `<a href="https://api.example.com/api/auth/reset-password?token=${TOKEN}">Reset</a>`;

  async function runSimulated() {
    const result = await sendEmail({
      to: "user@example.com",
      subject: "Reset your password - StyliAI",
      html: HTML,
    });
    const printed = logSpy.mock.calls.flat().join("\n");
    return { result, printed };
  }

  it("never prints the recovery token when the API key is missing", async () => {
    delete process.env.RESEND_API_KEY;

    const { result, printed } = await runSimulated();

    expect(result).toEqual({ id: "simulated_id" });
    expect(printed).not.toContain(TOKEN);
    expect(printed).not.toContain("reset-password");
  });

  it("never prints the recovery token when the API key is a YOUR_ placeholder", async () => {
    process.env.RESEND_API_KEY = "YOUR_RESEND_API_KEY_HERE";

    const { printed } = await runSimulated();

    expect(printed).not.toContain(TOKEN);
  });

  it("still logs the recipient and subject, so the branch stays debuggable", async () => {
    delete process.env.RESEND_API_KEY;

    const { printed } = await runSimulated();

    expect(printed).toContain("user@example.com");
    expect(printed).toContain("Reset your password - StyliAI");
    expect(warnSpy).toHaveBeenCalled();
  });
});
