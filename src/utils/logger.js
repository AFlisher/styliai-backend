"use strict";

/**
 * Phase 5 — the single structured emitter for the backend.
 *
 * Before this there were four conventions in the codebase at once: morgan's
 * coloured `dev` line, hand-rolled `console.error(JSON.stringify({event,...}))`
 * in the SEC-7.x/8.x paths, bare `console.error("Something:", err)`, and
 * `console.log` debugging left behind. Only the second was machine-readable, so
 * an operator could not answer "what happened to request X" from the log stream
 * at all - there was nothing tying lines together.
 *
 * Everything now goes through `emit`, which writes exactly one JSON object per
 * line. The existing structured emitters (logModerationRejection,
 * logGenerationBudgetEvent, logProviderError, logErasureEvent) already produced
 * `{event, ...}` objects and are deliberately left alone: their shapes are
 * pinned by tests and referenced in findings, and rewriting them would change
 * evidence for no operational gain. This module is additive - it standardises
 * the envelope around new events and gives every line a correlation id.
 *
 * ─── What must never appear in a log line ────────────────────────────────
 *
 * Passwords, JWTs, refresh tokens, API keys, secrets, verification and reset
 * tokens, and image bytes. Two independent mechanisms enforce that:
 *
 *   1. Callers pass metadata, never request bodies. There is no "log the whole
 *      object" helper here, on purpose - SEC-7.3's lesson was that
 *      `depth:null` on someone else's object is an unbounded promise.
 *   2. `redactFields` strips credential-shaped KEYS at every depth as a
 *      backstop, matching on the key name and never on the value, so no
 *      crafted value can evade it. Same reasoning as SEC-16.1's redactUrl.
 */

const SENSITIVE_KEY_PATTERN =
  /pass|token|secret|authorization|api[-_]?key|credential|totp|recovery|cookie|jwt|bearer/i;

/** Depth ceiling. Also severs cycles, so a circular input flattens rather than throwing. */
const MAX_DEPTH = 6;

/** One line must never become an unbounded write. */
const MAX_LINE_BYTES = 8 * 1024;

const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });

/**
 * The minimum level that is written. `LOG_LEVEL` overrides; the default keeps
 * test runs quiet without needing every suite to stub the console.
 */
function activeLevel() {
  const configured = (process.env.LOG_LEVEL || "").toLowerCase();
  if (LEVELS[configured]) return LEVELS[configured];
  if (process.env.NODE_ENV === "test") return LEVELS.error;
  return LEVELS.info;
}

/**
 * Recursively drops credential-shaped keys. Never inspects values: a rule that
 * looked at contents could be evaded by encoding, and would also risk logging
 * the very thing it was inspecting.
 */
function redactFields(value, depth = 0) {
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[depth]";
  if (Buffer.isBuffer(value)) return `[buffer ${value.length}b]`;
  if (Array.isArray(value)) return value.map((item) => redactFields(item, depth + 1));

  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      out[key] = "[REDACTED]";
      continue;
    }
    out[key] = redactFields(item, depth + 1);
  }
  return out;
}

/**
 * Writes one JSON line.
 *
 * Total by construction: this runs on the response path of every request and on
 * error paths where the caller has nothing useful to do with a failure. A
 * logger that can throw turns a handled error into an unhandled one - the same
 * hazard documented for morgan's token invocation (SEC-16.1) and the audit
 * hook's `finish` listener (SEC-15.1). Every failure degrades to a minimal
 * line, and the last resort swallows.
 *
 * @param {"debug"|"info"|"warn"|"error"} level
 * @param {string} event - snake_case, stable, greppable.
 * @param {object} [fields]
 */
function emit(level, event, fields = {}) {
  try {
    if ((LEVELS[level] || LEVELS.info) < activeLevel()) return;

    const line = {
      ts: new Date().toISOString(),
      level,
      event,
      ...redactFields(fields),
    };

    let serialized = JSON.stringify(line);

    if (serialized === undefined) {
      serialized = JSON.stringify({ ts: line.ts, level, event, note: "unserializable_fields" });
    } else if (Buffer.byteLength(serialized, "utf8") > MAX_LINE_BYTES) {
      serialized = JSON.stringify({
        ts: line.ts,
        level,
        event,
        requestId: fields.requestId,
        note: "truncated",
      });
    }

    // stderr for warn/error so a platform that splits streams keeps the
    // actionable lines separable; stdout for the rest.
    const stream = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;
    stream.write(serialized + "\n");
  } catch (_) {
    /* logging must never be the reason a request fails */
  }
}

const logger = {
  debug: (event, fields) => emit("debug", event, fields),
  info: (event, fields) => emit("info", event, fields),
  warn: (event, fields) => emit("warn", event, fields),
  error: (event, fields) => emit("error", event, fields),
};

module.exports = { logger, emit, redactFields, SENSITIVE_KEY_PATTERN, MAX_LINE_BYTES };
