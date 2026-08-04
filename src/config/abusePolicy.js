/**
 * SEC-18.1 / SEC-18.2 - every abuse threshold and every automatic action, in
 * one place.
 *
 * WHY A CONFIG FILE AND NOT CONSTANTS AT THE CALL SITE
 * ---------------------------------------------------
 * These numbers are the security policy. Scattered across three detectors they
 * drift, and - more importantly - an operator responding to a live incident
 * cannot retune a detector that is producing noise, or tighten one that is
 * missing an attack, without shipping a build. The rate limiters and the pool
 * bounds already follow this convention for exactly that reason.
 *
 * THE DEFAULTS ARE DELIBERATELY CONSERVATIVE, AND THIS IS THE KEY DECISION.
 * The audit's own analysis (Item 18.2) is that farming is currently
 * self-limiting: no signup bonus, no referral, and free credits cost two real
 * Google-verified ad impressions each, capped at one per account per day. So a
 * detector firing today is far more likely to be a false positive than an
 * attack, and the cost of a false positive is a real user locked out of an
 * account they paid attention to earn credits for.
 *
 * Therefore: AUTOMATIC SUSPENSION IS OFF BY DEFAULT. Detectors flag and score;
 * a human decides. The capability is built, wired and tested so that the day
 * the economics change - a signup bonus, a referral, a promo, or paid
 * purchases (SEC-6.1) - it is one environment variable, not a project.
 */

function envInt(name, fallback, env = process.env) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      JSON.stringify({
        event: "abuse_policy_override_ignored",
        variable: name,
        reason: "not_a_positive_number",
      })
    );
    return fallback;
  }
  return Math.floor(parsed);
}

function envFlag(name, fallback, env = process.env) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  return String(raw).trim().toLowerCase() === "true";
}

function buildPolicy(env = process.env) {
  return {
    // -----------------------------------------------------------------------
    // Registration velocity (SEC-18.1 detector 1, and SEC-4.1's mechanism)
    // -----------------------------------------------------------------------
    // "How many accounts appeared from one origin in one window."
    //
    // 6 in an hour is well above a household or a small office sharing an
    // address, and well below a farm. The audit warns that the country-level
    // version of this signal is indistinguishable from a successful marketing
    // campaign - which is precisely why this is keyed on the SEC-18.3 origin
    // hash instead. A campaign produces many accounts from many origins; a farm
    // produces many from few.
    registration: {
      windowHours: envInt("ABUSE_REG_WINDOW_HOURS", 1, env),
      perOriginThreshold: envInt("ABUSE_REG_PER_ORIGIN", 6, env),
      // The severity ladder exists so the risk score and any automatic action
      // can distinguish "unusual" from "unambiguous".
      perOriginHighThreshold: envInt("ABUSE_REG_PER_ORIGIN_HIGH", 20, env),
    },

    // -----------------------------------------------------------------------
    // Generation velocity (SEC-18.1 detector 2)
    // -----------------------------------------------------------------------
    // "Is this account generating at machine speed."
    //
    // Bounded above by real economics: a generation costs a credit, a credit
    // costs two watched ads, and the daily reward is capped at one per account
    // per day. So a HUMAN cannot legitimately reach a high hourly rate for
    // long - but a compromised account burning a purchased balance, or an
    // account exploiting a future promo, can. 30/hour is roughly one every two
    // minutes sustained, which no manual user produces.
    generation: {
      windowHours: envInt("ABUSE_GEN_WINDOW_HOURS", 1, env),
      perUserThreshold: envInt("ABUSE_GEN_PER_USER", 30, env),
      perUserHighThreshold: envInt("ABUSE_GEN_PER_USER_HIGH", 100, env),
    },

    // -----------------------------------------------------------------------
    // Wallet anomalies (SEC-18.1 detector 3)
    // -----------------------------------------------------------------------
    // The audit asks for daily-reward grants per origin, admin adjustments,
    // and any refund-failure marker.
    //
    // Reward grants per ORIGIN is the farming signal that country granularity
    // could not give: one credit per account per day is correct per account,
    // but twenty accounts behind one origin each claiming their one credit is
    // the farm, and every individual claim looks perfectly legitimate.
    wallet: {
      windowHours: envInt("ABUSE_WALLET_WINDOW_HOURS", 24, env),
      rewardsPerOriginThreshold: envInt("ABUSE_REWARDS_PER_ORIGIN", 10, env),
      rewardsPerOriginHighThreshold: envInt("ABUSE_REWARDS_PER_ORIGIN_HIGH", 30, env),
      // Admin balance adjustments are legitimate but are also the one way to
      // mint credits from nothing, so an unusual burst is worth surfacing -
      // this pairs with SEC-15.1's audit log, which records WHICH admin.
      adminAdjustmentsThreshold: envInt("ABUSE_ADMIN_ADJUSTMENTS", 25, env),
    },

    // -----------------------------------------------------------------------
    // Concurrent session origins (SEC-18.5)
    // -----------------------------------------------------------------------
    // The audit's point: the single most reliable signal that an account has
    // been stolen is simultaneous use from two places. Threshold is 3 rather
    // than 2 because a phone on mobile data plus the same phone on wifi is two
    // origins and is one honest person.
    session: {
      distinctOriginThreshold: envInt("ABUSE_SESSION_ORIGINS", 3, env),
      distinctOriginHighThreshold: envInt("ABUSE_SESSION_ORIGINS_HIGH", 6, env),
      windowHours: envInt("ABUSE_SESSION_WINDOW_HOURS", 24, env),
    },

    // -----------------------------------------------------------------------
    // Automatic enforcement (SEC-18.2's Phase 8 half)
    // -----------------------------------------------------------------------
    enforcement: {
      // OFF by default. See the header: today a firing detector is more likely
      // a false positive than an attack, and the cost of being wrong is locking
      // out a real user. Turning this on is a deliberate decision that should
      // follow a period of watching what the detectors actually flag.
      autoSuspendEnabled: envFlag("ABUSE_AUTO_SUSPEND", false, env),

      // Even when enabled, only 'high' severity findings may act. A 'medium'
      // finding is a request for human attention, never an action.
      autoSuspendMinSeverity: "high",

      // 'suspended' (reversible) rather than 'banned'. An automated system
      // should never take the irreversible-looking option; a human can escalate
      // after review, and reinstatement is a single existing endpoint.
      autoSuspendStatus: "suspended",

      // Detectors that may NEVER auto-suspend, whatever their severity.
      // Origin-scoped detectors implicate a GROUP - everyone behind a shared
      // NAT - so acting on them automatically would suspend bystanders. They
      // are strictly for human review.
      neverAutoSuspend: ["registration_velocity", "reward_farming_origin"],
    },

    // How often the opportunistic sweep may run. There is no scheduler in this
    // codebase (SEC-20.x), so detection piggybacks on request traffic the same
    // way integrityLedgerSweeper does.
    sweepIntervalMs: envInt("ABUSE_SWEEP_INTERVAL_MS", 15 * 60 * 1000, env),

    // Whether the opportunistic (request-triggered) sweep runs at all.
    //
    // Off under NODE_ENV=test by default, and this is a correctness measure
    // rather than a convenience. The existing suites drive the real Express app
    // through supertest against mocked `db` objects, several of which queue
    // ordered `mockResolvedValueOnce` responses. A fire-and-forget sweep firing
    // mid-request would consume those queued responses and shift every
    // subsequent expectation by one - failing tests for a reason with nothing
    // to do with what they assert. Phase 6 hit exactly this with the session
    // read and solved it with a mock; here the trigger is simply not armed,
    // because a sweep is a background job rather than part of any request's
    // behaviour. `runSweep` itself is fully exercised by its own suite.
    sweepEnabled: envFlag(
      "ABUSE_SWEEP_ENABLED",
      env.NODE_ENV !== "test",
      env
    ),

    // Detection is a read-heavy aggregate over wallet/generation history. It is
    // bounded so a sweep can never become the SEC-19.1 failure mode - cost that
    // grows with total lifetime usage.
    maxFindingsPerSweep: envInt("ABUSE_MAX_FINDINGS_PER_SWEEP", 200, env),
  };
}

module.exports = { buildPolicy, policy: buildPolicy(), envInt, envFlag };
