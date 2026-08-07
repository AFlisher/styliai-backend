/**
 * SEC-15.4: which admin role each privileged route requires.
 *
 * This table is the single source of truth. Route files register their guard by
 * looking a route up here (see requireAdminRoleFor in
 * middleware/requireAdminRole.js), and the matrix test drives every entry in it
 * through a real request. Neither side maintains its own copy, so a route and
 * its policy cannot drift apart, and a route added without a policy entry fails
 * at startup rather than silently inheriting "any admin can do this".
 *
 * Before this, authorization was a single boolean: adminAuthMiddleware checked
 * `role === 'admin'` and every route downstream inherited that one answer, so
 * an analyst who only needed to read stats necessarily also held the credit
 * faucet. Least privilege was not merely unconfigured - it was unexpressible.
 */

/**
 * Explicit numeric levels rather than string comparison or array position.
 * Authorization must not depend on `'superadmin' > 'editor'` happening to be
 * true in lexicographic order (it is - but 'viewer' > 'superadmin' is also
 * true, which is exactly the kind of accident this avoids).
 */
const ROLE_LEVEL = Object.freeze({
  viewer: 1,
  editor: 2,
  superadmin: 3,
});

const ADMIN_ROLES = Object.freeze(Object.keys(ROLE_LEVEL));

/** The role every newly provisioned admin gets unless told otherwise. */
const DEFAULT_ADMIN_ROLE = "viewer";

/**
 * Keyed by `METHOD <mounted path>` - the full path as a caller sees it, so the
 * table reads like the API surface rather than like the router files.
 *
 * Tiering rationale:
 *   viewer     - aggregate reads. No PII, no writes, no spend.
 *   editor     - product/catalog authoring. Changes what users see, but cannot
 *                move money, set prices, or read user records.
 *   superadmin - money (balances), pricing (credit packs), and user PII lookup.
 *
 * POST /api/admin/ai/generate-preview sits at editor: it spends real provider
 * money, but it is the Style Manager's "Test Prompt" tool and is unusable
 * without it. Its metering and logging are SEC-15.8, a separate open finding -
 * this table places the route, it does not fix that.
 *
 * Routes NOT listed here are deliberately absent, not forgotten:
 *   POST /api/admin/login          - unauthenticated by definition
 *   GET  /api/styles, /api/categories - optionalAdminAuth, serve the mobile app
 *   GET  /api/credit-packs         - public
 */
const ADMIN_ROUTE_POLICY = Object.freeze({
  // --- analytics: read-only ---
  "GET /api/admin/stats": "viewer",
  // Phase 5: per-process request/error/latency counters. A read, so viewer -
  // but not public: the auth-failure counters would tell an attacker whether
  // their probing is being noticed.
  "GET /api/admin/metrics": "viewer",
  "GET /api/admin/stats/countries": "viewer",
  "GET /api/admin/analytics/generation/overview": "viewer",
  "GET /api/admin/analytics/generation/summary": "viewer",
  // System Health module: composed entirely from aggregate reads (pool
  // stats, storage usage, sweep timestamps, schema_migrations, backup_runs)
  // plus an environment summary that is already redacted at its source
  // (envSummary.js) - no PII, no writes. Same tier as metrics/stats.
  "GET /api/admin/system-health": "viewer",
  "GET /api/admin/system-health/incidents": "viewer",

  // --- money, pricing and user records ---
  "GET /api/admin/users/search": "superadmin",
  // User Management & Moderation module: browsing/reading many user records is
  // the same PII exposure as searchUserByEmail's one-row lookup, just at
  // volume - same tier.
  "GET /api/admin/users": "superadmin",
  "GET /api/admin/users/:id": "superadmin",
  "POST /api/admin/users/:id/adjust-balance": "superadmin",
  // SEC-18.2: suspending an account terminates its sessions immediately and
  // stops it spending. Same tier as balance adjustment - both are irreversible
  // -feeling actions against a specific, identified user.
  "POST /api/admin/users/:id/suspend": "superadmin",
  "POST /api/admin/users/:id/reinstate": "superadmin",
  // Deletion is the same status-flip enforcement as suspend, so it gets the
  // same tier as the rest of this group.
  "POST /api/admin/users/:id/delete": "superadmin",

  // SEC-18.1 (Phase 8): the abuse review workflow.
  //
  // The two READS are viewer-tier on purpose. A review queue that only a
  // superadmin can look at is a queue nobody looks at, and the whole finding is
  // that nothing was watching. Neither read discloses more than the admin
  // surface already does: findings carry counts and thresholds, and the session
  // list carries origin HASHES, never addresses.
  "GET /api/admin/abuse/findings": "viewer",
  "GET /api/admin/abuse/risk": "viewer",
  // The session list is scoped to one named user, which puts it with the other
  // per-user lookups rather than with the aggregate views.
  "GET /api/admin/abuse/users/:id/sessions": "superadmin",
  // Both WRITES are superadmin: a recorded verdict is what future threshold
  // changes get argued from, and a manual sweep can suspend accounts when
  // automatic enforcement is enabled.
  "POST /api/admin/abuse/findings/:id/review": "superadmin",
  "POST /api/admin/abuse/sweep": "superadmin",
  "POST /api/credit-packs": "superadmin",
  "PUT /api/credit-packs/:id": "superadmin",
  "DELETE /api/credit-packs/:id": "superadmin",

  // Operations Center. superadmin, one tier above the abuse-findings reads:
  // these rows carry raw request IPs and admin emails across the WHOLE admin
  // surface (not scoped to findings' bounded evidence shape), so they sit
  // with the other PII/money-adjacent reads rather than with the aggregate
  // viewer-tier ones.
  "GET /api/admin/audit-log": "superadmin",
  "GET /api/admin/security-events": "superadmin",
  "GET /api/admin/purchases/verification-history": "superadmin",

  // --- catalog authoring ---
  "POST /api/admin/ai/generate-preview": "editor",

  "POST /api/styles": "editor",
  "POST /api/styles/prompt-preview": "editor",
  "PUT /api/styles/reorder": "editor",
  "PUT /api/styles/:id": "editor",
  "PATCH /api/styles/:id": "editor",
  "DELETE /api/styles/:id": "editor",

  "POST /api/categories": "editor",
  "PUT /api/categories/reorder": "editor",
  "PUT /api/categories/:id": "editor",
  "DELETE /api/categories/:id": "editor",

  // Tags are admin-only end to end (the whole router is guarded), so the read
  // needs a tier of its own rather than being public like the other reads.
  "GET /api/tags": "viewer",
  "POST /api/tags": "editor",
  "PUT /api/tags/:id": "editor",
  "DELETE /api/tags/:id": "editor",

  "POST /api/upload": "editor",
  "DELETE /api/upload": "editor",
});

/**
 * True when `actual` is at least as privileged as `required`.
 *
 * Fails closed on anything unrecognised: an absent claim (every token minted
 * before SEC-15.4 shipped), a misspelling, a role removed from ROLE_LEVEL but
 * still present in a live token, or a non-string. Unknown never means allowed.
 */
function roleSatisfies(actual, required) {
  // String-checked BEFORE the lookup. Property access coerces its key, so
  // `ROLE_LEVEL[["superadmin"]]` resolves via the array's toString and returns
  // a real level - a non-string that happens to stringify to a valid role name
  // would otherwise be granted. JWT claims are attacker-shaped data even when
  // the signature is sound, so the type is checked rather than assumed.
  if (typeof actual !== "string" || typeof required !== "string") {
    return false;
  }

  // hasOwnProperty rather than a bare lookup: ROLE_LEVEL is a plain object, so
  // "constructor"/"toString" would otherwise resolve to inherited members.
  if (!Object.prototype.hasOwnProperty.call(ROLE_LEVEL, actual) ||
      !Object.prototype.hasOwnProperty.call(ROLE_LEVEL, required)) {
    return false;
  }

  return ROLE_LEVEL[actual] >= ROLE_LEVEL[required];
}

/**
 * Looks up a route's required role.
 *
 * @throws {Error} when the key is not in the table. Called at module load from
 *   the route files, so a route registered without a policy entry crashes the
 *   process at startup instead of quietly serving without a guard.
 */
function requiredRoleFor(routeKey) {
  const role = ADMIN_ROUTE_POLICY[routeKey];

  if (!role) {
    throw new Error(
      `[adminRoutePolicy] no role defined for "${routeKey}". ` +
        "Add it to ADMIN_ROUTE_POLICY - every admin-guarded route needs an explicit tier."
    );
  }

  return role;
}

module.exports = {
  ROLE_LEVEL,
  ADMIN_ROLES,
  DEFAULT_ADMIN_ROLE,
  ADMIN_ROUTE_POLICY,
  roleSatisfies,
  requiredRoleFor,
};
