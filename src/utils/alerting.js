"use strict";

const { logger } = require("./logger");
const metrics = require("./metrics");

/**
 * Sprint 3 / H-3 — the thing that makes a failure reach a human.
 *
 * ─── The gap this closes ────────────────────────────────────────────────────
 *
 * The production readiness review found no crash reporting, no APM and no
 * alerting anywhere in three repositories. The single most important
 * operational event in the system - `[FINANCIAL INCONSISTENCY]`, logged when a
 * user was charged for a generation and the refund then failed - was a
 * `console.error` going to an unwatched stdout. Nothing in the system could
 * tell anyone that money had gone missing.
 *
 * ─── Why a webhook and not Sentry ───────────────────────────────────────────
 *
 * Sentry, Datadog and the rest all need an account, a DSN and a vendor
 * decision that is not this sprint's to make - and adding an SDK that sits
 * inert without a DSN would look like monitoring while providing none. A
 * webhook works today with a Slack or Discord incoming-webhook URL and no
 * signup, and it is the same shape every one of those vendors accepts anyway.
 * `ALERT_WEBHOOK_URL` unset means alerts are logged and counted but not
 * delivered, which is exactly the state before this file existed - so this is
 * strictly additive and cannot break a deployment that ignores it.
 *
 * ─── What it will not do ────────────────────────────────────────────────────
 *
 * It never throws, never blocks a request, and never retries. An alerting path
 * that can fail the operation it is reporting on is worse than no alerting: it
 * converts an incident into two. Delivery is best-effort by construction.
 */

/** Severity. Only `critical` and `error` are delivered by default. */
const SEVERITY = Object.freeze({
  CRITICAL: "critical",
  ERROR: "error",
  WARNING: "warning",
});

const DELIVERED_BY_DEFAULT = new Set([SEVERITY.CRITICAL, SEVERITY.ERROR]);

/**
 * Outbound timeout. Short: an alert that takes ten seconds to post is an alert
 * arriving after the thing it warned about has already finished going wrong.
 */
const WEBHOOK_TIMEOUT_MS = Number(process.env.ALERT_WEBHOOK_TIMEOUT_MS) || 3000;

/**
 * Per-event-name suppression window.
 *
 * A failing dependency does not produce one alert, it produces one per
 * request - and a channel with four thousand identical messages is a channel
 * nobody reads, which is the same as having no alerting. The first occurrence
 * in each window is delivered and the rest are counted, so the signal survives
 * the storm and the volume is still visible in the metrics.
 */
const DEDUPE_WINDOW_MS = Number(process.env.ALERT_DEDUPE_WINDOW_MS) || 300_000;

/**
 * In-memory, per-process, and bounded. Same honest caveat as utils/metrics.js:
 * with more than one replica each has its own view, so N replicas can deliver
 * up to N copies of the first alert. That is the correct failure direction -
 * duplicate delivery rather than suppressed delivery.
 */
const lastSentAt = new Map();
const suppressedSince = new Map();

/** Hard ceiling so a caller passing unbounded names cannot grow the map. */
const MAX_TRACKED_EVENTS = 200;

function shouldDeliver(event, now) {
  const last = lastSentAt.get(event);
  if (last === undefined || now - last >= DEDUPE_WINDOW_MS) {
    if (!lastSentAt.has(event) && lastSentAt.size >= MAX_TRACKED_EVENTS) {
      // Refuse to track anything new rather than grow without bound. The alert
      // is still logged; only its dedupe state is dropped.
      return { deliver: true, suppressed: 0 };
    }
    const suppressed = suppressedSince.get(event) || 0;
    lastSentAt.set(event, now);
    suppressedSince.set(event, 0);
    return { deliver: true, suppressed };
  }

  suppressedSince.set(event, (suppressedSince.get(event) || 0) + 1);
  return { deliver: false, suppressed: 0 };
}

function isConfigured(env = process.env) {
  return Boolean(env.ALERT_WEBHOOK_URL && String(env.ALERT_WEBHOOK_URL).trim());
}

/**
 * Posts the alert. Never throws, never awaited by callers.
 *
 * The payload uses `text` because that is what Slack and Discord incoming
 * webhooks both read, and a generic HTTP endpoint can ignore it. The
 * structured fields travel alongside for anything that parses JSON.
 */
async function deliver(payload, env = process.env) {
  const url = String(env.ALERT_WEBHOOK_URL).trim();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    // Deliberately only logged. Retrying a failed alert is how an alerting
    // path becomes the outage.
    logger.error("alert_delivery_failed", {
      event: payload.event,
      error: (err && err.message) || "unknown",
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Raises an alert.
 *
 * @param {string} event    short fixed label chosen by the code, never derived
 *                          from request input - it keys the dedupe map.
 * @param {object} options
 * @param {string} options.severity  one of SEVERITY
 * @param {string} options.message   one human sentence
 * @param {object} [options.context] small, non-sensitive structured detail
 */
function raise(event, { severity = SEVERITY.ERROR, message, context = {} } = {}) {
  try {
    if (typeof event !== "string" || !event || event.length > 64) return;

    metrics.increment(`alert_${severity}`);

    // Logged unconditionally, delivered conditionally. The log line is the
    // durable record; the webhook is the notification.
    const line = { event, severity, message, ...context };
    if (severity === SEVERITY.CRITICAL || severity === SEVERITY.ERROR) {
      logger.error("alert", line);
    } else {
      logger.warn("alert", line);
    }

    if (!isConfigured()) return;
    if (!DELIVERED_BY_DEFAULT.has(severity)) return;

    const { deliver: ok, suppressed } = shouldDeliver(event, Date.now());
    if (!ok) return;

    const prefix = severity === SEVERITY.CRITICAL ? "🔴 CRITICAL" : "🟠 ERROR";
    const suffix =
      suppressed > 0 ? ` (+${suppressed} suppressed in the last window)` : "";

    // Fire and forget. A caller must never wait on an alert.
    void deliver({
      text: `${prefix} · StyliAI · ${event}\n${message || ""}${suffix}`,
      event,
      severity,
      context,
      suppressedSinceLast: suppressed,
      environment: process.env.NODE_ENV || "development",
    });
  } catch (err) {
    // An alerting bug must not propagate into the code that was reporting a
    // problem. This is the one place where swallowing is the whole point.
    try {
      logger.error("alert_raise_failed", { error: (err && err.message) || "unknown" });
    } catch (_) {
      /* nothing left to do */
    }
  }
}

/** Test-only. */
function reset() {
  lastSentAt.clear();
  suppressedSince.clear();
}

module.exports = {
  raise,
  isConfigured,
  reset,
  SEVERITY,
  DEDUPE_WINDOW_MS,
  MAX_TRACKED_EVENTS,
};
