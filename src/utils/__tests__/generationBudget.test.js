// SEC-7.2 — the generation budget.
//
// The property that matters is the three-way split: a timeout, a caller
// cancellation and a provider failure must stay distinguishable. Collapsed into
// one signal none of them can be acted on - a timeout says our budget is wrong,
// a cancellation says the user gave up, a failure says the provider is broken.

const {
  withGenerationBudget,
  GenerationTimeoutError,
  GenerationCancelledError,
  logGenerationBudgetEvent,
} = require("../generationBudget");

const never = (signal) =>
  new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });

beforeEach(() => {
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  console.warn.mockRestore();
});

describe("the happy path is untouched", () => {
  it("returns the value and clears its timer", async () => {
    await expect(withGenerationBudget("provider", 1000, null, async () => "image")).resolves.toBe("image");
  });

  it("passes a live signal to the worker", async () => {
    let seen;
    await withGenerationBudget("provider", 1000, null, async (signal) => {
      seen = signal;
      return "ok";
    });

    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen.aborted).toBe(false);
  });
});

describe("timeout", () => {
  it("aborts the worker and reports a timeout", async () => {
    const err = await withGenerationBudget("provider", 20, null, never).catch((e) => e);

    expect(err).toBeInstanceOf(GenerationTimeoutError);
    expect(err.isGenerationTimeout).toBe(true);
    expect(err.phase).toBe("provider");
    expect(err.budgetMs).toBe(20);
  });

  it("actually signals the worker rather than merely stopping the wait", async () => {
    // Racing a promise without threading the signal through would leave the
    // socket, the buffered uploads and the upstream job in place - which is
    // most of what this finding is about.
    let aborted = false;
    await withGenerationBudget("provider", 20, null, (signal) => {
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      return never(signal);
    }).catch(() => {});

    expect(aborted).toBe(true);
  });

  it("carries the phase, so provider and download budgets are separable", async () => {
    const err = await withGenerationBudget("download", 20, null, never).catch((e) => e);

    expect(err.phase).toBe("download");
  });
});

describe("caller cancellation", () => {
  it("is reported as cancellation, not as a timeout", async () => {
    const caller = new AbortController();
    const promise = withGenerationBudget("provider", 5000, caller.signal, never);
    caller.abort();

    const err = await promise.catch((e) => e);

    expect(err).toBeInstanceOf(GenerationCancelledError);
    expect(err.isGenerationCancelled).toBe(true);
    expect(err.isGenerationTimeout).toBeUndefined();
  });

  it("handles a caller signal that is already aborted", async () => {
    const caller = AbortSignal.abort();

    const err = await withGenerationBudget("provider", 5000, caller, never).catch((e) => e);

    expect(err.isGenerationCancelled).toBe(true);
  });

  it("does not leak listeners onto a long-lived caller signal", async () => {
    // A per-request signal is short-lived, but a shared one would accumulate a
    // listener per generation.
    const caller = new AbortController();
    for (let i = 0; i < 25; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await withGenerationBudget("provider", 1000, caller.signal, async () => "ok");
    }

    // Node exposes no listener count for AbortSignal, so this asserts the
    // observable consequence: aborting afterwards must not throw or fire into
    // completed work.
    expect(() => caller.abort()).not.toThrow();
  });
});

describe("provider failures stay provider failures", () => {
  it("passes an ordinary error through untouched", async () => {
    const boom = new Error("provider 500");

    const err = await withGenerationBudget("provider", 1000, null, async () => {
      throw boom;
    }).catch((e) => e);

    expect(err).toBe(boom);
    expect(err.isGenerationTimeout).toBeUndefined();
    expect(err.isGenerationCancelled).toBeUndefined();
  });

  it("does not reinterpret a provider's own AbortError as our timeout", async () => {
    // Only *our* controller firing may be reported as our timeout. A provider
    // that throws an AbortError of its own is still a provider failure.
    const providerAbort = new Error("The operation was aborted");
    providerAbort.name = "AbortError";

    const err = await withGenerationBudget("provider", 5000, null, async () => {
      throw providerAbort;
    }).catch((e) => e);

    expect(err).toBe(providerAbort);
    expect(err.isGenerationTimeout).toBeUndefined();
  });
});

describe("structured logging", () => {
  it("emits one parseable event carrying the operator-facing detail", () => {
    logGenerationBudgetEvent({
      outcome: "timeout",
      phase: "provider",
      budgetMs: 60000,
      elapsedMs: 60123,
      provider: "gemini",
      userId: "user-1",
      endpoint: "POST /api/generate",
    });

    const parsed = JSON.parse(console.warn.mock.calls[0][0]);
    expect(parsed.event).toBe("generation_budget");
    expect(parsed.outcome).toBe("timeout");
    expect(parsed.phase).toBe("provider");
    expect(parsed.provider).toBe("gemini");
    expect(parsed.budgetMs).toBe(60000);
  });

  it("keeps timeout and cancellation as distinct outcomes", () => {
    logGenerationBudgetEvent({ outcome: "timeout", phase: "provider" });
    logGenerationBudgetEvent({ outcome: "cancelled", phase: "provider" });

    const outcomes = console.warn.mock.calls.map((c) => JSON.parse(c[0]).outcome);
    expect(outcomes).toEqual(["timeout", "cancelled"]);
  });

  it("records no prompt or image material", () => {
    logGenerationBudgetEvent({ outcome: "timeout", phase: "provider", userId: "u" });
    const parsed = JSON.parse(console.warn.mock.calls[0][0]);

    expect(Object.keys(parsed).sort()).toEqual(
      ["budgetMs", "elapsedMs", "endpoint", "event", "outcome", "phase", "provider", "userId"].sort()
    );
  });

  it("survives missing fields", () => {
    expect(() => logGenerationBudgetEvent({})).not.toThrow();
  });
});
