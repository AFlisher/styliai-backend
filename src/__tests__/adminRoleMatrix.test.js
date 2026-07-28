// SEC-15.4: end-to-end authorization matrix against the REAL app.
//
// Every entry in ADMIN_ROUTE_POLICY is driven through an actual request at
// every role. Because the route files register their guards from that same
// table, this cannot drift from what is enforced - and the coverage test at the
// bottom catches the opposite failure, an admin route that never got a tier.
//
// The reason this matters more here than in most findings: unlike SEC-15.1's
// audit middleware, this cannot be one global mount (the required tier differs
// per route), so it is ~27 individual registrations and a forgotten one
// silently keeps its old everyone-can-do-it behaviour. This file is what makes
// that loud.

process.env.ADMIN_JWT_SECRET = "test-only-secret-never-used-in-production";

jest.mock("../config/db", () => ({
  query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  pool: { connect: jest.fn() },
}));

const request = require("supertest");
const jwt = require("jsonwebtoken");
const {
  ADMIN_ROUTE_POLICY,
  ADMIN_ROLES,
  roleSatisfies,
} = require("../config/adminRoutePolicy");
const app = require("../app");

function tokenFor(adminRole) {
  const claims = {
    sub: "11111111-1111-1111-1111-111111111111",
    email: "admin@example.com",
    role: "admin",
  };
  // `undefined` models a token minted before SEC-15.4 shipped.
  if (adminRole !== undefined) claims.adminRole = adminRole;

  return jwt.sign(claims, process.env.ADMIN_JWT_SECRET, {
    algorithm: "HS256",
    expiresIn: "5m",
  });
}

/** Turns a policy key into something supertest can send. */
function toRequest(routeKey) {
  const [method, routePath] = routeKey.split(" ");
  const concretePath = routePath.replace(/:[a-zA-Z]+/g, "11111111-2222-3333-4444-555555555555");
  return { method: method.toLowerCase(), path: concretePath };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  console.error.mockRestore();
  console.warn.mockRestore();
});

const routeKeys = Object.keys(ADMIN_ROUTE_POLICY);

describe("every policy entry is enforced at every role", () => {
  // The full cross product: 27 routes x 3 roles.
  const cases = [];
  for (const routeKey of routeKeys) {
    for (const role of ADMIN_ROLES) {
      cases.push([routeKey, role, roleSatisfies(role, ADMIN_ROUTE_POLICY[routeKey])]);
    }
  }

  it.each(cases)("%s as %s", async (routeKey, role, shouldBeAllowed) => {
    const { method, path } = toRequest(routeKey);
    const res = await request(app)[method](path).set("Authorization", `Bearer ${tokenFor(role)}`);

    if (shouldBeAllowed) {
      // The handler may 400/404/500 on mocked data - what matters is that
      // authorization did not stop it.
      expect(res.status).not.toBe(403);
    } else {
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("INSUFFICIENT_ROLE");
    }
  });
});

describe("tokens without a role claim", () => {
  it.each(routeKeys)("%s is denied for a pre-SEC-15.4 token", async (routeKey) => {
    // Every admin token minted before this shipped looks like this. Denying is
    // the deliberate choice: a back-compat window where an absent claim grants
    // full privilege is structurally the SEC-1.1 mistake.
    const { method, path } = toRequest(routeKey);
    const res = await request(app)[method](path).set("Authorization", `Bearer ${tokenFor(undefined)}`);

    expect(res.status).toBe(403);
  });

  it.each([["misspelled", "supperadmin"], ["wrong case", "SuperAdmin"], ["empty", ""]])(
    "denies a %s role claim",
    async (_label, badRole) => {
      const res = await request(app)
        .get("/api/admin/stats")
        .set("Authorization", `Bearer ${tokenFor(badRole)}`);

      expect(res.status).toBe(403);
    }
  );
});

describe("authorization does not replace authentication", () => {
  it("still answers 401 with no token at all", async () => {
    const res = await request(app).delete("/api/styles/abc");
    expect(res.status).toBe(401);
  });

  it("still answers 401 for a token signed with the wrong secret", async () => {
    const forged = jwt.sign(
      { sub: "x", email: "e@x.com", role: "admin", adminRole: "superadmin" },
      "not-the-real-secret",
      { algorithm: "HS256" }
    );
    const res = await request(app)
      .delete("/api/styles/abc")
      .set("Authorization", `Bearer ${forged}`);

    expect(res.status).toBe(401);
  });

  it("cannot be escalated by putting a role in the body", async () => {
    const res = await request(app)
      .post("/api/credit-packs")
      .set("Authorization", `Bearer ${tokenFor("viewer")}`)
      .send({ adminRole: "superadmin", role: "superadmin", name: "x", credits: 1 });

    expect(res.status).toBe(403);
  });

  it("cannot be escalated by a header", async () => {
    const res = await request(app)
      .post("/api/credit-packs")
      .set("Authorization", `Bearer ${tokenFor("viewer")}`)
      .set("X-Admin-Role", "superadmin")
      .send({ name: "x", credits: 1 });

    expect(res.status).toBe(403);
  });
});

describe("policy coverage - no admin route may lack a tier", () => {
  /**
   * Collects every registered route as `{ methods, handlerNames }`.
   *
   * Only handler names are used, not paths: Express 5.2 replaced
   * `layer.regexp` with opaque `matchers`, so reconstructing a mounted path
   * from the router tree is version-fragile. Handler identity is stable, and
   * "is this route guarded" is the question that actually matters here. Route
   * existence is covered separately below, through the app's public behaviour.
   */
  function collectRoutes(stack) {
    const found = [];

    for (const layer of stack) {
      if (layer.route) {
        found.push({
          path: layer.route.path,
          methods: Object.keys(layer.route.methods || {}),
          handlerNames: layer.route.stack.map((s) => s.name),
        });
      } else if (layer.name === "router" && layer.handle && layer.handle.stack) {
        found.push(...collectRoutes(layer.handle.stack));
      }
    }

    return found;
  }

  const registered = collectRoutes((app.router || app._router).stack);

  it("finds the app's routes (guards against the walker silently returning nothing)", () => {
    // Without this, a walker that returned [] would make the assertion below
    // pass vacuously.
    expect(registered.length).toBeGreaterThan(20);
  });

  it("gives every per-route adminAuthMiddleware route a role guard", () => {
    // NOTE: this only sees routes where adminAuthMiddleware is registered on
    // the route itself. /api/tags guards its whole router with
    // `router.use(adminAuthMiddleware)`, so its four routes are authenticated
    // but never appear in this list - which is why the count check lives in
    // the next test, keyed on the role guard rather than on this one.
    const adminGuarded = registered.filter((r) =>
      r.handlerNames.includes("adminAuthMiddleware")
    );

    expect(adminGuarded.length).toBeGreaterThan(0);

    const missing = adminGuarded
      .filter((r) => !r.handlerNames.includes("adminRoleGuard"))
      .map((r) => `${r.methods.join("|").toUpperCase()} ${r.path}`);

    // A new admin route added without a tier lands here rather than shipping
    // with the old everyone-can-do-it behaviour.
    expect(missing).toEqual([]);
  });

  it("registers exactly as many role guards as the policy has entries", () => {
    // Catches both directions at once: a guard registered for a route missing
    // from the table (impossible - requireAdminRoleFor throws - but pinned
    // anyway), and a table entry whose guard was never wired up.
    const withRoleGuard = registered.filter((r) => r.handlerNames.includes("adminRoleGuard"));

    expect(withRoleGuard.length).toBe(routeKeys.length);
  });

  it.each(routeKeys)("%s names a route that actually exists", async (routeKey) => {
    // Catches the reverse drift: a policy entry left behind after a route was
    // renamed or removed, which would make the matrix above assert against a
    // 404 instead of a real handler.
    //
    // Checked through the public interface rather than router internals: the
    // app's catch-all 404 has a distinct body ("Resource not found."), so a
    // handler's own 404 ("Style not found.") is distinguishable from a route
    // that isn't registered at all.
    const { method, path } = toRequest(routeKey);
    const res = await request(app)[method](path).set("Authorization", `Bearer ${tokenFor("superadmin")}`);

    expect(res.body.message).not.toBe("Resource not found.");
  });
});
