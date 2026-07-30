"use strict";

/**
 * Phase 5 — a correlation id on every request.
 *
 * Without one, a log stream is a pile of unrelated lines: an operator holding a
 * 500 from a user cannot find the exception, the auth decision and the upload
 * failure that belong to it. `req.id` ties them together and is echoed to the
 * client in `X-Request-Id`, so a bug report can carry the id that finds the
 * server-side story - which is also why the error responses now include it.
 */

const crypto = require("crypto");

const HEADER = "X-Request-Id";

/**
 * An inbound id is honoured so a trace started at the edge survives into our
 * logs, but never trusted verbatim: it is echoed back to the client and written
 * into every log line, so an unbounded or control-character-bearing value would
 * be both a log-injection vector and a response-header-splitting one.
 *
 * Accepted: 8-64 chars of `[A-Za-z0-9_-]`. Anything else is replaced rather
 * than rejected - a malformed trace header is not worth failing a request over.
 */
function sanitizeInboundId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^[A-Za-z0-9_-]{8,64}$/.test(trimmed) ? trimmed : null;
}

function requestContext(req, res, next) {
  // Total by construction: this is the first middleware on every request, and
  // it must never be the reason one fails.
  try {
    req.id = sanitizeInboundId(req.get(HEADER)) || crypto.randomUUID();
    req.startedAt = process.hrtime.bigint();
    res.setHeader(HEADER, req.id);
  } catch (_) {
    req.id = req.id || "unknown";
  }
  next();
}

/** Milliseconds since `requestContext` ran, or null if it did not. */
function elapsedMs(req) {
  if (!req || typeof req.startedAt !== "bigint") return null;
  return Number(process.hrtime.bigint() - req.startedAt) / 1e6;
}

module.exports = requestContext;
module.exports.sanitizeInboundId = sanitizeInboundId;
module.exports.elapsedMs = elapsedMs;
module.exports.HEADER = HEADER;
