const integrityVerdictModel = require("../models/integrityVerdictModel");
const { config } = require("../config/playIntegrityConfig");

/**
 * SEC-0.4 — keeps the replay ledger bounded.
 *
 * integrityVerdictModel.evict() implements the two-stage retention that SEC-0.2
 * designed (drop the verdict payload after the short reuse window, drop the row
 * after the longer replay window) but nothing was calling it, so
 * integrity_verdicts would have grown for the life of the deployment - one row
 * per attested request, forever, each carrying device and Play-account
 * attestation data long after it could tell us anything.
 *
 * There is no scheduler in this codebase (see SEC-20.x), so the sweep is
 * opportunistic: a request may trigger it, at most once per interval, and never
 * waits for it. Two properties make that safe rather than merely convenient:
 *
 *   - The interval gate is set BEFORE the async work starts, so a burst of
 *     concurrent requests cannot each launch their own sweep. Node runs the
 *     synchronous part of maybeSweep() to completion before yielding, so there
 *     is no interleaving window - the same reasoning concurrentGenerationLimiter
 *     relies on, and it holds here only because the gate is set synchronously.
 *   - The promise is never awaited by the request, and always carries a
 *     .catch(). An unhandled rejection from a fire-and-forget sweep would be an
 *     uncaught exception, which in Node kills the process - the same class of
 *     hazard as SEC-16.1's morgan token and SEC-15.1's response hook.
 *
 * Worst case if a sweep is missed: rows live a little longer than the retention
 * window. Worst case if it ran on every request: a DELETE per API call.
 */

let lastSweepAt = 0;
let sweeping = false;

/**
 * Fire-and-forget. Returns immediately; the caller must not await it.
 *
 * Exported return value is for tests only - it says whether a sweep was
 * started, not whether one finished.
 */
function maybeSweep() {
  const now = Date.now();
  if (sweeping) return false;
  if (now - lastSweepAt < config.sweepIntervalMs) return false;

  // Both flags set synchronously, before any await can yield.
  lastSweepAt = now;
  sweeping = true;

  integrityVerdictModel
    .evict()
    .then((result) => {
      if (result && (result.verdictsDropped || result.rowsDeleted)) {
        console.log(
          JSON.stringify({
            event: "integrity_ledger_sweep",
            verdictsDropped: result.verdictsDropped,
            rowsDeleted: result.rowsDeleted,
          })
        );
      }
    })
    .catch((err) => {
      // Never rethrow. Retention is housekeeping; a failed sweep must not be
      // able to take down the API.
      console.error("[integrityLedgerSweeper] sweep failed:", err && err.message);
    })
    .finally(() => {
      sweeping = false;
    });

  return true;
}

function resetForTest() {
  lastSweepAt = 0;
  sweeping = false;
}

module.exports = { maybeSweep, resetForTest };
