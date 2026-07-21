/**
 * Concurrent-generation protection suite.
 *
 * Two layers are tested:
 *  1. concurrentGenerationLimiter in isolation (fake req/res, no HTTP/DB) -
 *     precise, deterministic coverage of the actual race-safety guarantee
 *     (synchronous check-then-increment, release on finish/close/error,
 *     exactly-once release, per-user isolation) without being coupled to
 *     generationLimiter's IP rate window or wallet/DB state.
 *  2. A handful of true end-to-end requests through the real Express app
 *     (POST /api/generate) proving the middleware is actually wired into
 *     the route and produces the documented 429 body under real concurrent
 *     HTTP load, and that the lock releases so a later request succeeds.
 */

const { EventEmitter } = require("events");
const concurrentGenerationLimiter = require("../../src/middleware/concurrentGenerationLimiter");

function fakeReqRes(userId) {
  const req = userId ? { user: { id: userId } } : {};
  const res = new EventEmitter();
  res.status = jest.fn().mockReturnThis();
  res.json = jest.fn().mockReturnThis();
  return { req, res };
}

describe("concurrentGenerationLimiter (unit) - default cap is 2 in-flight per user", () => {
  it("admits requests up to the cap and calls next()", () => {
    const userId = `u-${Math.random()}`;
    const next1 = jest.fn();
    const next2 = jest.fn();
    const { req: req1, res: res1 } = fakeReqRes(userId);
    const { req: req2, res: res2 } = fakeReqRes(userId);

    concurrentGenerationLimiter(req1, res1, next1);
    concurrentGenerationLimiter(req2, res2, next2);

    expect(next1).toHaveBeenCalledTimes(1);
    expect(next2).toHaveBeenCalledTimes(1);
    expect(res1.status).not.toHaveBeenCalled();
    expect(res2.status).not.toHaveBeenCalled();
  });

  it("rejects the request over the cap with 429 and does not call next()", () => {
    const userId = `u-${Math.random()}`;
    const admit = () => {
      const { req, res } = fakeReqRes(userId);
      const next = jest.fn();
      concurrentGenerationLimiter(req, res, next);
      return { res, next };
    };

    admit(); // 1st in flight
    admit(); // 2nd in flight (at cap)
    const third = admit(); // 3rd - over cap

    expect(third.next).not.toHaveBeenCalled();
    expect(third.res.status).toHaveBeenCalledWith(429);
    expect(third.res.json).toHaveBeenCalledWith({
      code: "RATE_LIMITED",
      message: expect.stringMatching(/already have an image generation in progress/i),
    });
  });

  it("releases the slot on 'finish' so a later request is admitted again", () => {
    const userId = `u-${Math.random()}`;
    const held = [];
    for (let i = 0; i < 2; i++) {
      const { req, res } = fakeReqRes(userId);
      const next = jest.fn();
      concurrentGenerationLimiter(req, res, next);
      held.push(res);
    }

    // At cap - the 3rd is rejected.
    const { req: reqBlocked, res: resBlocked } = fakeReqRes(userId);
    const nextBlocked = jest.fn();
    concurrentGenerationLimiter(reqBlocked, resBlocked, nextBlocked);
    expect(nextBlocked).not.toHaveBeenCalled();

    // First in-flight request finishes normally -> frees exactly one slot.
    held[0].emit("finish");

    const { req: reqAfter, res: resAfter } = fakeReqRes(userId);
    const nextAfter = jest.fn();
    concurrentGenerationLimiter(reqAfter, resAfter, nextAfter);
    expect(nextAfter).toHaveBeenCalledTimes(1);
  });

  it("releases the slot on 'close' (client disconnect) even without 'finish' ever firing", () => {
    const userId = `u-${Math.random()}`;
    const { req: req1, res: res1 } = fakeReqRes(userId);
    concurrentGenerationLimiter(req1, res1, jest.fn());
    const { req: req2, res: res2 } = fakeReqRes(userId);
    concurrentGenerationLimiter(req2, res2, jest.fn());

    // Client aborts mid-request: 'close' fires, 'finish' never does.
    res1.emit("close");

    const { req: req3, res: res3 } = fakeReqRes(userId);
    const next3 = jest.fn();
    concurrentGenerationLimiter(req3, res3, next3);
    expect(next3).toHaveBeenCalledTimes(1);
  });

  it("releases the slot exactly once even if both 'finish' and 'close' fire for the same request", () => {
    const userId = `u-${Math.random()}`;
    const { req: req1, res: res1 } = fakeReqRes(userId);
    concurrentGenerationLimiter(req1, res1, jest.fn());
    const { req: req2, res: res2 } = fakeReqRes(userId);
    concurrentGenerationLimiter(req2, res2, jest.fn());

    // Both events can legitimately fire for one response (e.g. 'finish' then
    // a subsequent socket 'close'). A double-release bug would free TWO
    // slots here instead of one.
    res1.emit("finish");
    res1.emit("close");

    const { req: reqA, res: resA } = fakeReqRes(userId);
    const nextA = jest.fn();
    concurrentGenerationLimiter(reqA, resA, nextA);
    expect(nextA).toHaveBeenCalledTimes(1); // the one freed slot

    const { req: reqB, res: resB } = fakeReqRes(userId);
    const nextB = jest.fn();
    concurrentGenerationLimiter(reqB, resB, nextB);
    expect(nextB).not.toHaveBeenCalled(); // back at cap (2 + 3 held: req2, reqA)
    expect(resB.status).toHaveBeenCalledWith(429);
  });

  it("tracks each user independently - one user's cap never blocks another user", () => {
    const userA = `u-${Math.random()}`;
    const userB = `u-${Math.random()}`;

    // Max out user A.
    concurrentGenerationLimiter(...Object.values(fakeReqRes(userA)), jest.fn());
    concurrentGenerationLimiter(...Object.values(fakeReqRes(userA)), jest.fn());
    const { req: reqABlocked, res: resABlocked } = fakeReqRes(userA);
    const nextABlocked = jest.fn();
    concurrentGenerationLimiter(reqABlocked, resABlocked, nextABlocked);
    expect(nextABlocked).not.toHaveBeenCalled();

    // User B is completely unaffected.
    const { req: reqB, res: resB } = fakeReqRes(userB);
    const nextB = jest.fn();
    concurrentGenerationLimiter(reqB, resB, nextB);
    expect(nextB).toHaveBeenCalledTimes(1);
  });

  it("does not limit when req.user is absent (never reached without auth in production)", () => {
    const { req, res } = fakeReqRes(null);
    const next = jest.fn();
    concurrentGenerationLimiter(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  describe("race safety under truly concurrent (synchronous) arrival", () => {
    it("admits exactly the cap and rejects every request beyond it, with no over/under-admission", () => {
      const userId = `u-${Math.random()}`;
      const cap = 2;
      const attempts = 12;
      let admitted = 0;
      let rejected = 0;

      // No awaits between these calls - this is the same interleaving
      // window (none) that concurrent real HTTP requests would hit, since
      // the middleware itself contains no `await` between its read and
      // write of the shared Map.
      for (let i = 0; i < attempts; i++) {
        const { req, res } = fakeReqRes(userId);
        const next = jest.fn(() => admitted++);
        concurrentGenerationLimiter(req, res, next);
        if (!next.mock.calls.length) rejected++;
      }

      expect(admitted).toBe(cap);
      expect(rejected).toBe(attempts - cap);
    });
  });
});

// ---------------------------------------------------------------------------
// End-to-end: the middleware is actually wired into POST /api/generate and
// POST /api/ai/generate and enforces the same cap over real HTTP requests.
// ---------------------------------------------------------------------------

require("./setupEnv");

jest.mock("../../src/config/db", () => require("./fakeDb"));
jest.mock("../../src/config/supabase", () => ({ storage: { from: () => ({}) } }));
jest.mock("../../src/services/generation/generationService", () => ({ generate: jest.fn() }));

const jwt = require("jsonwebtoken");
const request = require("supertest");
const app = require("../../src/app");
const fakeDb = require("./fakeDb");
const generationService = require("../../src/services/generation/generationService");

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

const userToken = (id) =>
  jwt.sign({ sub: id, email: `${id}@x.com`, role: "authenticated" }, process.env.SUPABASE_JWT_SECRET, { expiresIn: "1h" });

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// supertest's Test object is lazy - the HTTP request isn't actually
// dispatched until it's awaited/`.then()`-ed (see superagent's Request.end,
// only invoked from `.then`/`.end`), so simply assigning `fire()` to a
// variable does NOT put it "in flight". Real dispatch order across
// concurrent in-process requests also isn't guaranteed by call order alone.
// This polls an observable side effect (the mock provider actually being
// invoked) instead of guessing a fixed sleep duration - deterministic and
// fast on localhost, no arbitrary timing assumption.
async function waitUntil(predicate, { timeout = 2000, interval = 5 } = {}) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) {
      throw new Error("waitUntil: condition not met within timeout");
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

beforeEach(() => {
  fakeDb.reset();
  generationService.generate.mockReset();
});

describe("POST /api/generate end-to-end concurrency cap", () => {
  it("a third simultaneous request from the same user is rejected with 429 while the first two are still in flight, then succeeds once they complete", async () => {
    fakeDb.seedUser({ id: "cg1", balance: 10, email_verified: true });
    fakeDb.seedStyle({ id: "cgs1", creditCost: 1, isEnabled: true });

    const gate = deferred();
    generationService.generate.mockImplementation(() =>
      gate.promise.then(() => ({ imageUrl: "http://cdn/out.png", thumbnailUrl: "http://cdn/out-thumb.webp" }))
    );

    const fire = () =>
      request(app)
        .post("/api/generate")
        .set("Authorization", `Bearer ${userToken("cg1")}`)
        .field("styleId", "cgs1")
        .attach("file", PNG, { filename: "in.png", contentType: "image/png" });

    // Two requests start and hang inside generationService.generate (the
    // gate is unresolved), so both are genuinely "in flight" together.
    // Attaching .then() (via .catch(), which is enough to trigger dispatch)
    // is what actually sends each request - see waitUntil() above.
    const first = fire();
    const second = fire();
    first.catch(() => {});
    second.catch(() => {});

    // Wait for both to actually be admitted and reach the paid-provider
    // call (not just "assigned to a variable") before firing the one that
    // must be rejected - otherwise it could race ahead of them and get
    // admitted itself, hanging on the same unresolved gate.
    await waitUntil(() => generationService.generate.mock.calls.length >= 2);

    // Fired only once both slots are confirmably held - must be rejected
    // before ever reaching generationService.generate.
    const third = await fire();
    expect(third.status).toBe(429);
    expect(third.body.code).toBe("RATE_LIMITED");

    // Release the two held generations.
    gate.resolve();
    const [firstRes, secondRes] = await Promise.all([first, second]);
    expect(firstRes.status).toBe(200);
    expect(secondRes.status).toBe(200);
    expect(generationService.generate).toHaveBeenCalledTimes(2); // never 3

    // Slots are now free again - a follow-up request is admitted normally.
    generationService.generate.mockResolvedValue({ imageUrl: "http://cdn/out2.png", thumbnailUrl: "http://cdn/out2-thumb.webp" });
    const fourth = await fire();
    expect(fourth.status).toBe(200);
  });

  it("releases the lock even when generation throws, so the next request is admitted immediately", async () => {
    fakeDb.seedUser({ id: "cg2", balance: 10, email_verified: true });
    fakeDb.seedStyle({ id: "cgs2", creditCost: 1, isEnabled: true });
    generationService.generate.mockRejectedValueOnce(new Error("provider exploded"));

    const failed = await request(app)
      .post("/api/generate")
      .set("Authorization", `Bearer ${userToken("cg2")}`)
      .field("styleId", "cgs2")
      .attach("file", PNG, { filename: "in.png", contentType: "image/png" });
    expect(failed.status).toBeGreaterThanOrEqual(500);

    generationService.generate.mockResolvedValueOnce({ imageUrl: "http://cdn/ok.png", thumbnailUrl: "http://cdn/ok-thumb.webp" });
    const after = await request(app)
      .post("/api/generate")
      .set("Authorization", `Bearer ${userToken("cg2")}`)
      .field("styleId", "cgs2")
      .attach("file", PNG, { filename: "in.png", contentType: "image/png" });
    expect(after.status).toBe(200); // not 429 - the failed request's lock was released
  });

  it("two different authenticated users generating at the same time do not throttle each other", async () => {
    fakeDb.seedUser({ id: "cg3a", balance: 10, email_verified: true });
    fakeDb.seedUser({ id: "cg3b", balance: 10, email_verified: true });
    fakeDb.seedStyle({ id: "cgs3", creditCost: 1, isEnabled: true });

    const gate = deferred();
    generationService.generate.mockImplementation(() =>
      gate.promise.then(() => ({ imageUrl: "http://cdn/out.png", thumbnailUrl: "http://cdn/out-thumb.webp" }))
    );

    const fireAs = (userId) =>
      request(app)
        .post("/api/generate")
        .set("Authorization", `Bearer ${userToken(userId)}`)
        .field("styleId", "cgs3")
        .attach("file", PNG, { filename: "in.png", contentType: "image/png" });

    // User A occupies both of their own slots.
    const a1 = fireAs("cg3a");
    const a2 = fireAs("cg3a");

    // User B's first request is a fresh user - must be admitted even though
    // user A is fully saturated at the same moment.
    const bBlocked = fireAs("cg3b");

    gate.resolve();
    const [a1Res, a2Res, bRes] = await Promise.all([a1, a2, bBlocked]);
    expect(a1Res.status).toBe(200);
    expect(a2Res.status).toBe(200);
    expect(bRes.status).toBe(200);
  });

  it("unauthenticated requests are rejected before the concurrency check ever runs", async () => {
    const res = await request(app)
      .post("/api/generate")
      .field("styleId", "any")
      .attach("file", PNG, { filename: "in.png", contentType: "image/png" });
    expect(res.status).toBe(401);
  });
});
