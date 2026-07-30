"use strict";

/**
 * Phase 5 — in-process counters and latency, for monitoring.
 *
 * Deliberately in-memory and deliberately small. This is not a metrics backend:
 * Railway's replica count is unknown, so these numbers describe one process
 * since its last restart and nothing more. That is stated on the endpoint that
 * serves them, because a number that looks fleet-wide and is not is worse than
 * no number at all.
 *
 * What it is for: answering "is the error rate moving", "are auth failures
 * spiking", "did p95 latency change after the last deploy" without standing up
 * an external system first. When one arrives (SEC-16.5), this is the shape that
 * feeds it.
 *
 * Latency is kept as bucket counts rather than raw samples so memory is bounded
 * by construction - an unbounded array of every request's duration is a leak
 * with extra steps.
 */

const LATENCY_BUCKETS_MS = [25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000];

function freshState() {
  return {
    startedAt: new Date().toISOString(),
    requests: { total: 0, byStatusClass: { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 } },
    // Counters keyed by a short, bounded label. Anything unbounded (a raw path,
    // a user id) would let a caller grow this map without limit.
    events: {},
    latency: {
      count: 0,
      totalMs: 0,
      maxMs: 0,
      buckets: LATENCY_BUCKETS_MS.reduce((acc, b) => ({ ...acc, [`le_${b}`]: 0 }), { le_inf: 0 }),
    },
  };
}

let state = freshState();

function statusClass(status) {
  if (status >= 500) return "5xx";
  if (status >= 400) return "4xx";
  if (status >= 300) return "3xx";
  return "2xx";
}

/** Records one completed request. Never throws. */
function recordRequest({ status, durationMs }) {
  try {
    state.requests.total += 1;
    const cls = statusClass(Number(status) || 0);
    state.requests.byStatusClass[cls] = (state.requests.byStatusClass[cls] || 0) + 1;

    if (typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0) {
      state.latency.count += 1;
      state.latency.totalMs += durationMs;
      if (durationMs > state.latency.maxMs) state.latency.maxMs = durationMs;

      const bucket = LATENCY_BUCKETS_MS.find((b) => durationMs <= b);
      const key = bucket === undefined ? "le_inf" : `le_${bucket}`;
      state.latency.buckets[key] += 1;
    }
  } catch (_) {
    /* metrics must never break a request */
  }
}

/**
 * Increments a named counter.
 *
 * `name` must be a short fixed label chosen by the code, never derived from
 * request input - a caller-controlled key is an unbounded memory write.
 */
function increment(name, by = 1) {
  try {
    if (typeof name !== "string" || name.length === 0 || name.length > 64) return;
    state.events[name] = (state.events[name] || 0) + by;
  } catch (_) {
    /* as above */
  }
}

/** A point-in-time copy. Safe to serialize; contains no request-derived data. */
function snapshot() {
  const { latency } = state;
  return {
    processStartedAt: state.startedAt,
    uptimeSeconds: Math.round(process.uptime()),
    requests: {
      total: state.requests.total,
      byStatusClass: { ...state.requests.byStatusClass },
      errorRate:
        state.requests.total === 0
          ? 0
          : Number(
              (
                (state.requests.byStatusClass["5xx"] + state.requests.byStatusClass["4xx"]) /
                state.requests.total
              ).toFixed(4)
            ),
      serverErrorRate:
        state.requests.total === 0
          ? 0
          : Number((state.requests.byStatusClass["5xx"] / state.requests.total).toFixed(4)),
    },
    latency: {
      count: latency.count,
      avgMs: latency.count === 0 ? 0 : Number((latency.totalMs / latency.count).toFixed(2)),
      maxMs: Number(latency.maxMs.toFixed(2)),
      buckets: { ...latency.buckets },
    },
    events: { ...state.events },
  };
}

/** Test-only. Production never resets counters except by restarting. */
function reset() {
  state = freshState();
}

module.exports = { recordRequest, increment, snapshot, reset, LATENCY_BUCKETS_MS };
