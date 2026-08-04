const { AppError, ErrorCodes } = require("./errors");

/**
 * SEC-19.2 / SEC-9.3 - shared bounds for every list endpoint.
 *
 * WHY
 * ---
 * Of eleven models, only two used LIMIT at all. `getCreationsByUser` returned
 * every creation a user had ever made - no LIMIT, no OFFSET, no cursor - each
 * row carrying a full image URL and a thumbnail URL, and the client fetched it
 * on the app-open path. Nothing was pathological *today*, and the reason was
 * economic rather than architectural: a creation costs a credit and a credit
 * costs two watched ads, so histories grow slowly.
 *
 * That brake is the thing most likely to be removed. The moment credit
 * purchases ship (SEC-6.1), a paying user can accumulate thousands of
 * creations, and the cost is paid three times over - Postgres materialises
 * every row, Node serialises the whole array, the client parses and holds it -
 * degrading precisely for the customers who pay. Retrofitting pagination after
 * that point also means a client change, which is why the audit's fix order
 * puts this before purchases rather than after.
 *
 * ATTACK PREVENTED
 * ----------------
 * Primarily self-inflicted resource exhaustion rather than an adversary:
 * response size that scales with account age with no ceiling at any layer. It
 * does also remove an amplification primitive - one cheap authenticated
 * request that returns an unbounded amount of data is a useful lever for a
 * caller trying to spend server memory and bandwidth rather than their own.
 *
 * KEYSET, NOT OFFSET
 * ------------------
 * `WHERE (created_at, id) < (cursor)` reads the existing
 * idx_creations_user_created index directly and costs the same on page 500 as
 * on page 1, whereas OFFSET makes the database walk and discard every skipped
 * row - so an OFFSET-based "fix" would leave the exhaustion path open and just
 * move it behind a query parameter. Keyset is also stable under concurrent
 * inserts: a new creation arriving mid-scroll cannot shift rows onto a page
 * the client already read.
 */

/**
 * Clamps a caller-supplied `limit` into [1, max].
 *
 * Absent/blank -> the default. Malformed (non-numeric, NaN, Infinity) -> the
 * default, deliberately NOT a 400: `?limit=abc` is a client bug, and answering
 * it with a sensible page is both kinder and no less safe, since the value is
 * bounded either way. Out-of-range values ARE clamped rather than rejected for
 * the same reason - the security property is the ceiling, not the complaint.
 */
function clampLimit(raw, { def, max }) {
  if (raw === undefined || raw === null || raw === "") return def;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return def;

  // Math.floor before clamping, so `?limit=1e9` and `?limit=50.9` both land
  // somewhere sane rather than reaching a query as a float.
  const floored = Math.floor(parsed);
  if (floored < 1) return 1;
  if (floored > max) return max;
  return floored;
}

/**
 * Reads a positive-integer environment bound, ignoring anything unparseable.
 *
 * Same convention as rateLimiters.js and config/db.js: a typo falls back to
 * the safe default with a warning rather than producing a page size of 0 (an
 * endpoint that returns nothing) or NaN (an endpoint with no bound at all).
 */
function envInt(name, fallback, env = process.env) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      JSON.stringify({
        event: "pagination_override_ignored",
        variable: name,
        reason: "not_a_positive_number",
      })
    );
    return fallback;
  }
  return Math.floor(parsed);
}

/**
 * The composite cursor for `ORDER BY created_at DESC, id DESC`.
 *
 * `created_at` alone is NOT a valid cursor: the column is a plain TIMESTAMP
 * with no uniqueness guarantee, and two creations written in the same
 * millisecond (entirely possible - a migrate call inserts in a loop) would
 * make a timestamp-only cursor either skip a row or repeat one forever. The id
 * is the tiebreaker that makes the ordering total.
 *
 * Encoded as base64url of "<iso>|<uuid>" so it is opaque to the client. That
 * is not a security control - it carries nothing secret, and it is signed by
 * nothing - it exists so clients treat the cursor as a token to echo back
 * rather than a structure to construct, which is what keeps the ordering an
 * implementation detail we can change later.
 */
function encodeCursor(createdAt, id) {
  const iso = createdAt instanceof Date ? createdAt.toISOString() : String(createdAt);
  return Buffer.from(`${iso}|${id}`, "utf8").toString("base64url");
}

/**
 * Decodes a cursor, throwing a 400 on anything malformed.
 *
 * Unlike `limit`, a bad cursor IS rejected rather than defaulted: silently
 * restarting from page one on a corrupt cursor would present as an infinite
 * scroll that loops forever, which is worse than an error. Both components are
 * validated - the timestamp must parse and the id must be a UUID - so nothing
 * unchecked reaches the query, even though it is parameterised.
 */
function decodeCursor(raw) {
  const invalid = () =>
    new AppError(ErrorCodes.VALIDATION_ERROR, "cursor is not valid.", 400);

  if (typeof raw !== "string" || raw.length === 0 || raw.length > 512) {
    throw invalid();
  }

  let decoded;
  try {
    decoded = Buffer.from(raw, "base64url").toString("utf8");
  } catch (_) {
    throw invalid();
  }

  const sep = decoded.lastIndexOf("|");
  if (sep <= 0) throw invalid();

  const iso = decoded.slice(0, sep);
  const id = decoded.slice(sep + 1);

  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) throw invalid();

  if (
    !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id)
  ) {
    throw invalid();
  }

  return { createdAt: at.toISOString(), id };
}

// ---------------------------------------------------------------------------
// Per-endpoint bounds
// ---------------------------------------------------------------------------

// GET /api/creations. The default is what a client that sends no parameters
// receives; the max is what it can ask for. 50 comfortably exceeds what any
// current account holds (see the credit economics above), so shipping this
// changes nothing observable today while putting the ceiling in place before
// it is needed.
const CREATIONS_PAGE_DEFAULT = envInt("CREATIONS_PAGE_SIZE_DEFAULT", 50);
const CREATIONS_PAGE_MAX = envInt("CREATIONS_PAGE_SIZE_MAX", 100);

// GET /api/favorites returns bare style ids, not rows, so it is far cheaper
// per item and gets a correspondingly looser ceiling. It is still a ceiling:
// the point is that no list endpoint is unbounded, not that every list is
// bounded at the same number.
const FAVORITES_PAGE_MAX = envInt("FAVORITES_PAGE_SIZE_MAX", 1000);

// Catalog reads (styles, categories). Curated admin content, small and slow-
// growing, and the mobile Home screen deliberately fetches the whole category
// set in one call - a decision already recorded as the deferred preview-fetch
// work. So this is sized as a runaway guard rather than a page size: high
// enough that no realistic catalog is truncated, low enough that a catalog
// which grows unexpectedly cannot serialise without limit.
const CATALOG_PAGE_MAX = envInt("CATALOG_PAGE_SIZE_MAX", 500);

// GET /api/styles/:id/similar (SEC-9.3). The recommendation candidate set is
// small, so `?limit=99999999` only ever returned the whole catalog - the audit
// rates the impact negligible today and the finding a validation smell. 50 is
// well above the ~10 the client asks for.
const RECOMMENDATION_LIMIT_DEFAULT = 10;
const RECOMMENDATION_LIMIT_MAX = envInt("RECOMMENDATION_LIMIT_MAX", 50);

module.exports = {
  clampLimit,
  encodeCursor,
  decodeCursor,
  envInt,
  CREATIONS_PAGE_DEFAULT,
  CREATIONS_PAGE_MAX,
  FAVORITES_PAGE_MAX,
  CATALOG_PAGE_MAX,
  RECOMMENDATION_LIMIT_DEFAULT,
  RECOMMENDATION_LIMIT_MAX,
};
