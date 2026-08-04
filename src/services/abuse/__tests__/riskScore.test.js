const { scoreAccount, WEIGHTS } = require("../riskScore");

const NOW = new Date("2026-08-04T12:00:00.000Z");
const daysAgo = (d) => new Date(NOW.getTime() - d * 24 * 3600 * 1000).toISOString();

/** A long-standing, verified, ordinary account. */
const cleanAccount = (over = {}) => ({
  userId: "u1",
  accountCreatedAt: daysAgo(400),
  emailVerified: true,
  provider: "email",
  status: "active",
  generations: 12,
  rewards: 20,
  originSiblings: 1,
  ...over,
});

describe("SEC-18.1 — false positives: ordinary accounts score low", () => {
  // The most important property. A score that flags normal users is a score
  // nobody will read after the first week.
  it("scores an established, verified, ordinary account at zero", () => {
    const { score } = scoreAccount(cleanAccount(), NOW);
    expect(score).toBe(0);
  });

  it("does not punish a household sharing one connection", () => {
    // Two or three accounts behind one origin is a couple or a family.
    const { score } = scoreAccount(cleanAccount({ originSiblings: 3 }), NOW);
    expect(score).toBeLessThan(20);
  });

  it("only mildly penalises a brand-new legitimate account", () => {
    // Every real user is new once; scoring the whole signup funnel as
    // suspicious on day one would make the metric useless.
    const { score } = scoreAccount(
      cleanAccount({ accountCreatedAt: daysAgo(0), rewards: 0, generations: 0 }),
      NOW
    );
    expect(score).toBeLessThanOrEqual(WEIGHTS.accountAge);
  });

  it("does not flag a user who generates roughly what they earned", () => {
    const { score } = scoreAccount(cleanAccount({ generations: 30, rewards: 30 }), NOW);
    expect(score).toBe(0);
  });
});

describe("SEC-18.1 — abuse shapes score high", () => {
  it("scores the farm shape highly: many siblings, unverified, new, never generated", () => {
    const { score, factors } = scoreAccount(
      cleanAccount({
        originSiblings: 24,
        emailVerified: false,
        accountCreatedAt: daysAgo(0),
        rewards: 5,
        generations: 0,
      }),
      NOW
    );
    expect(score).toBeGreaterThanOrEqual(60);
    expect(factors.originSiblings).toBeDefined();
    expect(factors.unverified).toBeDefined();
    expect(factors.neverGenerated).toBeDefined();
  });

  it("ramps with origin siblings rather than stepping", () => {
    const at = (n) => scoreAccount(cleanAccount({ originSiblings: n }), NOW).score;
    expect(at(1)).toBeLessThan(at(4));
    expect(at(4)).toBeLessThan(at(12));
    expect(at(12)).toBeLessThanOrEqual(at(40));
  });

  it("flags spending far beyond what was earned", () => {
    const { factors } = scoreAccount(cleanAccount({ generations: 200, rewards: 2 }), NOW);
    expect(factors.rewardToGenerationRatio).toBeDefined();
  });
});

describe("SEC-18.1 — the score is explainable and bounded", () => {
  it("never exceeds 100 even when every factor fires at maximum", () => {
    const { score } = scoreAccount(
      {
        userId: "u",
        accountCreatedAt: daysAgo(0),
        emailVerified: false,
        provider: "email",
        status: "suspended",
        generations: 100000,
        rewards: 0,
        originSiblings: 100000,
      },
      NOW
    );
    expect(score).toBeLessThanOrEqual(100);
    expect(score).toBeGreaterThanOrEqual(0);
  });

  it("records a points value for every factor that contributed", () => {
    const { score, factors } = scoreAccount(
      cleanAccount({ originSiblings: 20, emailVerified: false }),
      NOW
    );
    const summed = Object.values(factors).reduce((t, f) => t + f.points, 0);
    // The explanation must actually add up to the score - an explanation that
    // does not reconstruct the number is not an explanation.
    expect(summed).toBe(score);
  });

  it("tolerates missing or malformed signals without throwing", () => {
    expect(() => scoreAccount({}, NOW)).not.toThrow();
    expect(() => scoreAccount({ accountCreatedAt: "not-a-date" }, NOW)).not.toThrow();
    expect(() => scoreAccount({ originSiblings: null, generations: undefined }, NOW)).not.toThrow();
  });

  // VACUITY PROBES ---------------------------------------------------------
  it("VACUITY: the score is not a constant", () => {
    const low = scoreAccount(cleanAccount(), NOW).score;
    const high = scoreAccount(
      cleanAccount({ originSiblings: 30, emailVerified: false, rewards: 9, generations: 0 }),
      NOW
    ).score;
    expect(low).not.toBe(high);
    expect(high).toBeGreaterThan(low);
  });

  it("VACUITY: an account with no risk factors produces an EMPTY explanation", () => {
    // If `factors` were always populated, the explanation would be noise and
    // the "summed === score" test above would pass vacuously.
    const { factors } = scoreAccount(cleanAccount(), NOW);
    expect(Object.keys(factors)).toHaveLength(0);
  });
});
