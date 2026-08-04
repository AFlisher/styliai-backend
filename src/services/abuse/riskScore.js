/**
 * SEC-18.1 - a per-account risk score.
 *
 * WHAT THIS IS: a RANKING AID. It exists so a human opening the dashboard looks
 * at the right twenty accounts first. That is the entirety of its job.
 *
 * WHAT THIS IS NOT, and the distinction is load-bearing:
 *   - It is NOT a probability. Nothing here is calibrated against any labelled
 *     data, because no labelled data exists - there has never been a confirmed
 *     abuse case in this system to calibrate against.
 *   - It is NOT an authorization input. No middleware reads it, no endpoint
 *     branches on it, and automatic suspension keys off explicit high-severity
 *     detector findings rather than off this number. A score that silently
 *     gated access would be an unreviewable, uncalibrated authorization
 *     decision - which is how a well-meaning heuristic becomes an outage for
 *     real users nobody can explain.
 *
 * EVERY CONTRIBUTION IS RECORDED IN `factors`. An unexplainable score cannot be
 * acted on and cannot be debugged when it is wrong; "account 7f3a scores 62"
 * is useless, "62 = 25 (18 accounts share its origin) + 20 (unverified) + 17
 * (no ads watched, 40 generations)" is a case a human can agree or disagree
 * with. This is also what makes a threshold argument possible later: you can
 * only tune what you can see.
 *
 * The audit's suggested signals are used as given: account age, verified
 * provider, country, ads-to-generation ratio - plus origin siblings, which is
 * the one SEC-18.3 newly makes available and the strongest of them.
 */

// Each factor names its own ceiling so the total cannot silently exceed 100 as
// factors are added, and so a single signal can never dominate on its own. The
// caps matter: without them, one account sharing an origin with a large
// carrier-grade NAT pool would score 100 on that basis alone.
const WEIGHTS = {
  originSiblings: 30,
  unverified: 15,
  accountAge: 15,
  rewardToGenerationRatio: 20,
  neverGenerated: 10,
  suspendedHistory: 10,
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {object} signals row from detectors.riskSignalsForUsers
 * @param {Date}   now     injectable for deterministic tests
 * @returns {{score:number, factors:object}}
 */
function scoreAccount(signals, now = new Date()) {
  const factors = {};
  let score = 0;

  // --- Origin siblings: the strongest available multi-account signal. -------
  // Ramps rather than steps, so 2 accounts behind one origin (a couple sharing
  // a flat) is nearly free while 20 is decisive. Logarithmic-ish by intent: the
  // difference between 1 and 5 siblings is far more meaningful than between 50
  // and 55.
  const siblings = Number(signals.originSiblings) || 1;
  if (siblings > 1) {
    const raw = Math.min(1, Math.log2(siblings) / Math.log2(24));
    const points = Math.round(raw * WEIGHTS.originSiblings);
    if (points > 0) {
      score += points;
      factors.originSiblings = { value: siblings, points };
    }
  }

  // --- Unverified email. ----------------------------------------------------
  // Note the asymmetry the audit points out: the Google path produces an
  // INSTANTLY verified account with no email round-trip, so "verified" is a
  // weaker signal there than on the email path. Google accounts therefore get
  // no credit for being verified - they inherit Google's own abuse controls,
  // which is a real but different assurance.
  if (!signals.emailVerified) {
    score += WEIGHTS.unverified;
    factors.unverified = { value: true, points: WEIGHTS.unverified };
  }

  // --- Account age. ---------------------------------------------------------
  // New accounts are riskier, but only mildly: every legitimate user is new
  // once, and penalising that heavily would score the entire genuine signup
  // funnel as suspicious on their first day.
  const createdAt = signals.accountCreatedAt ? new Date(signals.accountCreatedAt) : null;
  if (createdAt && !Number.isNaN(createdAt.getTime())) {
    const ageDays = (now.getTime() - createdAt.getTime()) / DAY_MS;
    if (ageDays < 7) {
      const points = Math.round(((7 - Math.max(0, ageDays)) / 7) * WEIGHTS.accountAge);
      if (points > 0) {
        score += points;
        factors.accountAge = { ageDays: Math.round(ageDays * 10) / 10, points };
      }
    }
  }

  // --- Credits consumed without earning them. -------------------------------
  // The audit's "ads-to-generation ratio". A user who has generated far more
  // than their reward claims could fund has obtained credits some other way -
  // an admin grant, a promo, or something that warrants a look. Deliberately
  // generous (3x) because the ratio is legitimately lopsided for anyone who
  // was granted credits by support.
  const generations = Number(signals.generations) || 0;
  const rewards = Number(signals.rewards) || 0;
  if (generations > 5 && generations > rewards * 3) {
    const excess = generations - rewards * 3;
    const raw = Math.min(1, excess / 50);
    const points = Math.round(raw * WEIGHTS.rewardToGenerationRatio);
    if (points > 0) {
      score += points;
      factors.rewardToGenerationRatio = { generations, rewards, points };
    }
  }

  // --- Claimed rewards but never generated. ---------------------------------
  // The farming shape: the value of a farmed account is the credit, not the
  // image, so a farm accumulates balance it never spends. A real user
  // eventually makes something.
  if (rewards >= 3 && generations === 0) {
    score += WEIGHTS.neverGenerated;
    factors.neverGenerated = { rewards, generations, points: WEIGHTS.neverGenerated };
  }

  // --- Already actioned. ----------------------------------------------------
  // A previously suspended account that is active again was reinstated by a
  // human; keeping a small residual keeps it visible without re-punishing it.
  if (signals.status && signals.status !== "active") {
    score += WEIGHTS.suspendedHistory;
    factors.status = { value: signals.status, points: WEIGHTS.suspendedHistory };
  }

  return { score: Math.max(0, Math.min(100, score)), factors };
}

module.exports = { scoreAccount, WEIGHTS };
