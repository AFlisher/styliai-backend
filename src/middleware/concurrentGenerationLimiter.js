const { ErrorCodes } = require("../utils/errors");

// Per-user count of in-flight generation requests, shared across both
// POST /api/generate and POST /api/ai/generate so a user can't dodge the cap
// by spreading a burst across the two endpoints. Deliberately in-memory
// (no DB/Redis round trip) - IP/route rate limiting alone can't stop this,
// since a single authenticated user firing many parallel requests from one
// IP stays under any reasonable per-IP request-rate limit while still
// racking up many simultaneous paid AI provider calls.
const MAX_CONCURRENT_GENERATIONS = Number(process.env.MAX_CONCURRENT_GENERATIONS) || 2;

const activeCounts = new Map();

/**
 * Caps how many generation requests a single authenticated user can have in
 * flight at once. Must run after authMiddleware (reads req.user.id).
 *
 * Race-safety: Node runs the synchronous body of a middleware function to
 * completion before yielding to any other request's callback (no `await`
 * appears between the read and the write below), so two "simultaneous"
 * requests for the same user can never both read the same pre-increment
 * count - there is no interleaving window to race in, unlike a
 * read-then-write across an async DB round trip.
 */
function concurrentGenerationLimiter(req, res, next) {
  const userId = req.user && req.user.id;
  if (!userId) {
    return next();
  }

  const current = activeCounts.get(userId) || 0;
  if (current >= MAX_CONCURRENT_GENERATIONS) {
    return res.status(429).json({
      code: ErrorCodes.RATE_LIMITED,
      message: "You already have an image generation in progress. Please wait for it to finish before starting another.",
    });
  }
  activeCounts.set(userId, current + 1);

  // Release exactly once no matter how the request ends: a normal response,
  // a thrown error / next(err) handled by app.js's global error middleware
  // (both still call res.end() under the hood -> 'finish'), or the client
  // disconnecting mid-request ('close' fires without 'finish' ever firing).
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const remaining = activeCounts.get(userId);
    if (!remaining || remaining <= 1) {
      activeCounts.delete(userId);
    } else {
      activeCounts.set(userId, remaining - 1);
    }
  };
  res.on("finish", release);
  res.on("close", release);

  next();
}

module.exports = concurrentGenerationLimiter;
