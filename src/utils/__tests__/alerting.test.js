"use strict";

/**
 * Sprint 3 / H-3 — alerting.
 *
 * The contract this file defends is mostly about what alerting must NOT do.
 * An alerting path that throws, blocks, or retries turns one incident into
 * two, and a channel that receives four thousand identical messages is a
 * channel nobody reads - which is indistinguishable from having no alerting,
 * the state this replaced.
 */

jest.mock("../logger", () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

const { logger } = require("../logger");
const alerting = require("../alerting");

const ORIGINAL_ENV = { ...process.env };
let fetchMock;

beforeEach(() => {
  jest.clearAllMocks();
  alerting.reset();
  process.env = { ...ORIGINAL_ENV };
  delete process.env.ALERT_WEBHOOK_URL;

  fetchMock = jest.fn().mockResolvedValue({ ok: true });
  global.fetch = fetchMock;
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

/** Alerts deliver via a floating promise; let the microtask queue drain. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("without a webhook configured", () => {
  it("still records the alert", () => {
    alerting.raise("thing_broke", {
      severity: alerting.SEVERITY.CRITICAL,
      message: "it broke",
    });

    // The log line is the durable record; the webhook is only the
    // notification. Losing the notification must not lose the record.
    expect(logger.error).toHaveBeenCalledWith(
      "alert",
      expect.objectContaining({ event: "thing_broke", severity: "critical" })
    );
  });

  it("does not attempt delivery", () => {
    alerting.raise("thing_broke", { severity: alerting.SEVERITY.ERROR, message: "x" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports itself unconfigured", () => {
    expect(alerting.isConfigured({})).toBe(false);
    expect(alerting.isConfigured({ ALERT_WEBHOOK_URL: "  " })).toBe(false);
    expect(alerting.isConfigured({ ALERT_WEBHOOK_URL: "https://hooks.example" })).toBe(true);
  });
});

describe("with a webhook configured", () => {
  beforeEach(() => {
    process.env.ALERT_WEBHOOK_URL = "https://hooks.example/abc";
  });

  it("delivers a critical alert", async () => {
    alerting.raise("money_lost", {
      severity: alerting.SEVERITY.CRITICAL,
      message: "a refund failed",
      context: { userId: "u1" },
    });
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://hooks.example/abc");
    expect(init.method).toBe("POST");

    const body = JSON.parse(init.body);
    expect(body.event).toBe("money_lost");
    expect(body.severity).toBe("critical");
    // `text` is what Slack and Discord incoming webhooks both read.
    expect(body.text).toContain("money_lost");
    expect(body.context).toEqual({ userId: "u1" });
  });

  it("does not deliver a warning", async () => {
    alerting.raise("minor", { severity: alerting.SEVERITY.WARNING, message: "meh" });
    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("never throws when delivery fails", async () => {
    fetchMock.mockRejectedValue(new Error("webhook down"));

    expect(() =>
      alerting.raise("thing", { severity: alerting.SEVERITY.ERROR, message: "x" })
    ).not.toThrow();
    await flush();

    expect(logger.error).toHaveBeenCalledWith(
      "alert_delivery_failed",
      expect.objectContaining({ event: "thing" })
    );
  });

  it("does not retry a failed delivery", async () => {
    fetchMock.mockRejectedValue(new Error("webhook down"));

    alerting.raise("thing", { severity: alerting.SEVERITY.ERROR, message: "x" });
    await flush();

    // Retrying an alert is how the alerting path becomes the outage.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("aborts a slow webhook rather than hanging", async () => {
    let signal;
    fetchMock.mockImplementation((_url, init) => {
      signal = init.signal;
      return Promise.resolve({ ok: true });
    });

    alerting.raise("thing", { severity: alerting.SEVERITY.ERROR, message: "x" });
    await flush();

    expect(signal).toBeDefined();
    expect(signal.aborted).toBe(false);
  });
});

describe("deduplication", () => {
  beforeEach(() => {
    process.env.ALERT_WEBHOOK_URL = "https://hooks.example/abc";
  });

  it("delivers the first occurrence and suppresses the storm", async () => {
    for (let i = 0; i < 50; i++) {
      alerting.raise("db_down", { severity: alerting.SEVERITY.ERROR, message: "down" });
    }
    await flush();

    // A failing dependency produces one alert per request. Fifty messages is
    // a muted channel, which is the same as no alerting.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still records every occurrence in the log", () => {
    for (let i = 0; i < 5; i++) {
      alerting.raise("db_down", { severity: alerting.SEVERITY.ERROR, message: "down" });
    }

    // Suppression is about notification volume, not about losing the events.
    const alertLines = logger.error.mock.calls.filter(([name]) => name === "alert");
    expect(alertLines).toHaveLength(5);
  });

  it("reports how many were suppressed on the next delivery", async () => {
    jest.useFakeTimers();
    try {
      alerting.raise("db_down", { severity: alerting.SEVERITY.ERROR, message: "down" });
      for (let i = 0; i < 9; i++) {
        alerting.raise("db_down", { severity: alerting.SEVERITY.ERROR, message: "down" });
      }

      jest.advanceTimersByTime(alerting.DEDUPE_WINDOW_MS + 1);
      alerting.raise("db_down", { severity: alerting.SEVERITY.ERROR, message: "down" });
    } finally {
      jest.useRealTimers();
    }
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const second = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(second.suppressedSinceLast).toBe(9);
    expect(second.text).toContain("9 suppressed");
  });

  it("dedupes per event name, not globally", async () => {
    alerting.raise("a_broke", { severity: alerting.SEVERITY.ERROR, message: "x" });
    alerting.raise("b_broke", { severity: alerting.SEVERITY.ERROR, message: "y" });
    await flush();

    // Two different problems are two different alerts.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("input bounds", () => {
  beforeEach(() => {
    process.env.ALERT_WEBHOOK_URL = "https://hooks.example/abc";
  });

  it("ignores a missing or oversized event name", async () => {
    alerting.raise("", { severity: alerting.SEVERITY.ERROR, message: "x" });
    alerting.raise("x".repeat(65), { severity: alerting.SEVERITY.ERROR, message: "x" });
    alerting.raise(null, { severity: alerting.SEVERITY.ERROR, message: "x" });
    await flush();

    // The event name keys the dedupe map, so an unbounded one is an unbounded
    // memory write.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("survives being called with no options at all", () => {
    expect(() => alerting.raise("bare")).not.toThrow();
  });
});
