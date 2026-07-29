/**
 * SEC-7.2 — bounded, cancellable generation work.
 *
 * One helper, used by every provider, so that "how long may this take" is
 * answered in exactly one place and the three outcomes stay distinguishable:
 *
 *   GenerationTimeoutError    our budget elapsed
 *   GenerationCancelledError  the caller went away (client disconnected)
 *   anything else             the provider genuinely failed
 *
 * Keeping those apart matters for the same reason SEC-0.2 separates an attacker
 * from an outage and SEC-7.1 separates a policy refusal from a provider
 * failure: collapsed into one signal, none of them can be acted on. A timeout
 * says our budget is wrong; a cancellation says the user gave up; a failure
 * says the provider is broken. They call for three different responses.
 *
 * ⚠️ A TIMEOUT DOES NOT SAVE PROVIDER SPEND.
 *
 * Google states this outright in the SDK types: "AbortSignal is a client-only
 * operation. Using it to cancel an operation will not cancel the request in the
 * service. You will still be charged usage for any applicable operations." The
 * same is true of fal's queue. Aborting reclaims *our* resources — the request
 * handler, the socket, and up to 50 MB of buffered uploads held by multer's
 * memoryStorage — and lets the user be refunded promptly. It does not stop the
 * meter upstream. A budget set too tight therefore produces the worst outcome
 * available: we pay, the user is refunded, and nobody gets an image.
 */

class GenerationTimeoutError extends Error {
  constructor(phase, budgetMs) {
    const shown = budgetMs >= 1000 ? `${Math.round(budgetMs / 1000)}s` : `${budgetMs}ms`;
    super(`Generation ${phase} exceeded its ${shown} budget.`);
    this.name = "GenerationTimeoutError";
    this.isGenerationTimeout = true;
    this.phase = phase;
    this.budgetMs = budgetMs;
  }
}

class GenerationCancelledError extends Error {
  constructor(phase) {
    super(`Generation ${phase} was cancelled by the caller.`);
    this.name = "GenerationCancelledError";
    this.isGenerationCancelled = true;
    this.phase = phase;
  }
}

/**
 * Runs `fn(signal)` under a time budget, optionally linked to a caller signal.
 *
 * `fn` receives an AbortSignal it is expected to pass to the underlying SDK or
 * fetch. Racing a promise without threading the signal through would stop us
 * *waiting* while leaving the socket, the buffers and the upstream job in
 * place — which is most of what this finding is about.
 *
 * Signals are linked by hand rather than with AbortSignal.any() so this does
 * not depend on the deployment's Node version, and the listener is always
 * removed so a long-lived caller signal cannot accumulate listeners.
 *
 * @param {string} phase - 'provider' or 'download'; appears in errors and logs.
 * @param {number} budgetMs
 * @param {AbortSignal|null|undefined} callerSignal
 * @param {(signal: AbortSignal) => Promise<any>} fn
 */
async function withGenerationBudget(phase, budgetMs, callerSignal, fn) {
  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, budgetMs);

  const onCallerAbort = () => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) {
      controller.abort();
    } else {
      callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    }
  }

  try {
    // Fail fast rather than starting work for a caller who has already gone.
    // This is not just tidiness: providers bill on submission, so launching a
    // call for an abandoned request spends money that can never reach a user.
    if (controller.signal.aborted) {
      throw timedOut
        ? new GenerationTimeoutError(phase, budgetMs)
        : new GenerationCancelledError(phase);
    }

    return await fn(controller.signal);
  } catch (err) {
    if (err instanceof GenerationTimeoutError || err instanceof GenerationCancelledError) {
      throw err;
    }
    // Only reinterpret the error if *we* aborted. A provider that happens to
    // throw an AbortError of its own must not be reported as our timeout.
    if (controller.signal.aborted) {
      if (timedOut) throw new GenerationTimeoutError(phase, budgetMs);
      throw new GenerationCancelledError(phase);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (callerSignal) callerSignal.removeEventListener("abort", onCallerAbort);
  }
}

/**
 * One structured line per bounded-generation outcome that was not a plain
 * success. Metadata only — no prompt, no image, consistent with SEC-7.1.
 */
function logGenerationBudgetEvent({ outcome, phase, budgetMs, elapsedMs, provider, userId, endpoint }) {
  console.warn(
    JSON.stringify({
      event: "generation_budget",
      outcome, // 'timeout' | 'cancelled'
      phase,
      provider: provider || null,
      budgetMs: budgetMs || null,
      elapsedMs: typeof elapsedMs === "number" ? elapsedMs : null,
      userId: userId || null,
      endpoint: endpoint || null,
    })
  );
}

module.exports = {
  withGenerationBudget,
  GenerationTimeoutError,
  GenerationCancelledError,
  logGenerationBudgetEvent,
};
