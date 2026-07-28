// SEC-15.4: the role guard and the level comparison behind it.
//
// The properties that matter are the negative ones: unknown never means
// allowed, the tier comes only from the verified token, and a denial must not
// masquerade as a session expiry.

const {
  ROLE_LEVEL,
  ADMIN_ROLES,
  roleSatisfies,
  requiredRoleFor,
  ADMIN_ROUTE_POLICY,
} = require("../../config/adminRoutePolicy");
const { requireAdminRole, requireAdminRoleFor } = require("../requireAdminRole");

function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

function run(guard, req) {
  const res = makeRes();
  const next = jest.fn();
  guard(req, res, next);
  return { res, next };
}

describe("roleSatisfies", () => {
  it("lets each role satisfy its own tier", () => {
    for (const role of ADMIN_ROLES) {
      expect(roleSatisfies(role, role)).toBe(true);
    }
  });

  it("lets higher tiers satisfy lower ones", () => {
    expect(roleSatisfies("superadmin", "editor")).toBe(true);
    expect(roleSatisfies("superadmin", "viewer")).toBe(true);
    expect(roleSatisfies("editor", "viewer")).toBe(true);
  });

  it("does not let lower tiers satisfy higher ones", () => {
    expect(roleSatisfies("viewer", "editor")).toBe(false);
    expect(roleSatisfies("viewer", "superadmin")).toBe(false);
    expect(roleSatisfies("editor", "superadmin")).toBe(false);
  });

  it("compares by explicit level, not by string ordering", () => {
    // 'viewer' > 'superadmin' lexicographically, which is exactly the accident
    // an ordering-based implementation would make.
    expect("viewer" > "superadmin").toBe(true);
    expect(roleSatisfies("viewer", "superadmin")).toBe(false);
    expect(ROLE_LEVEL.superadmin).toBeGreaterThan(ROLE_LEVEL.viewer);
  });

  it.each([
    ["undefined (token predates SEC-15.4)", undefined],
    ["null", null],
    ["empty string", ""],
    ["a misspelling", "supperadmin"],
    ["different casing", "SuperAdmin"],
    ["a removed role", "owner"],
    ["a number", 3],
    ["an object", {}],
    ["an array", ["superadmin"]],
    ["a prototype key", "constructor"],
    ["__proto__", "__proto__"],
    ["toString", "toString"],
  ])("fails closed on %s", (_label, actual) => {
    expect(roleSatisfies(actual, "viewer")).toBe(false);
  });

  it("fails closed when the REQUIRED role is unrecognised", () => {
    expect(roleSatisfies("superadmin", "nonsense")).toBe(false);
    expect(roleSatisfies("superadmin", undefined)).toBe(false);
  });
});

describe("requireAdminRole", () => {
  it("calls next() when the tier is sufficient", () => {
    const { next, res } = run(requireAdminRole("editor"), {
      admin: { id: "a1", adminRole: "superadmin" },
    });

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("answers 403 - not 401 - when the tier is insufficient", () => {
    const { next, res } = run(requireAdminRole("superadmin"), {
      admin: { id: "a1", adminRole: "viewer" },
    });

    expect(next).not.toHaveBeenCalled();
    // 401 would trip the dashboard's global logout interceptor, signing a
    // viewer out for clicking a button they simply aren't allowed to use.
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json.mock.calls[0][0].code).toBe("INSUFFICIENT_ROLE");
  });

  it("denies a token minted before roles existed", () => {
    const { next, res } = run(requireAdminRole("viewer"), {
      admin: { id: "a1", email: "a@example.com", role: "admin" },
    });

    // No grandfathering: an absent claim must not read as full privilege.
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("ignores a role supplied in the request body", () => {
    const { next, res } = run(requireAdminRole("superadmin"), {
      admin: { id: "a1", adminRole: "viewer" },
      body: { adminRole: "superadmin", role: "superadmin" },
    });

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("ignores a role supplied in headers or query", () => {
    const { next, res } = run(requireAdminRole("editor"), {
      admin: { id: "a1", adminRole: "viewer" },
      headers: { "x-admin-role": "superadmin" },
      query: { adminRole: "superadmin" },
    });

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("answers 401 if it somehow runs before authentication", () => {
    const { next, res } = run(requireAdminRole("viewer"), {});

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("does not leak the required tier in the denial message", () => {
    const { res } = run(requireAdminRole("superadmin"), {
      admin: { id: "a1", adminRole: "viewer" },
    });

    const body = JSON.stringify(res.json.mock.calls[0][0]);
    expect(body).not.toContain("superadmin");
  });
});

describe("requireAdminRoleFor - policy lookup", () => {
  it("builds a guard from the policy table", () => {
    const guard = requireAdminRoleFor("POST /api/admin/users/:id/adjust-balance");

    expect(run(guard, { admin: { adminRole: "superadmin" } }).next).toHaveBeenCalled();
    expect(run(guard, { admin: { adminRole: "editor" } }).res.status).toHaveBeenCalledWith(403);
  });

  it("throws at registration time for a route with no policy entry", () => {
    // Registration happens at module load, so this is a startup crash rather
    // than an endpoint that quietly serves without a guard.
    expect(() => requireAdminRoleFor("DELETE /api/something-new")).toThrow(
      /no role defined/
    );
  });
});

describe("policy table integrity", () => {
  it("only assigns known roles", () => {
    for (const [route, role] of Object.entries(ADMIN_ROUTE_POLICY)) {
      expect(ADMIN_ROLES).toContain(role);
      expect(() => requiredRoleFor(route)).not.toThrow();
    }
  });

  it("keeps money, pricing and PII at superadmin", () => {
    // The tiering decision itself, pinned - a future edit that quietly demotes
    // one of these to editor is the mistake worth catching.
    expect(ADMIN_ROUTE_POLICY["POST /api/admin/users/:id/adjust-balance"]).toBe("superadmin");
    expect(ADMIN_ROUTE_POLICY["GET /api/admin/users/search"]).toBe("superadmin");
    expect(ADMIN_ROUTE_POLICY["POST /api/credit-packs"]).toBe("superadmin");
    expect(ADMIN_ROUTE_POLICY["PUT /api/credit-packs/:id"]).toBe("superadmin");
    expect(ADMIN_ROUTE_POLICY["DELETE /api/credit-packs/:id"]).toBe("superadmin");
  });

  it("is frozen, so nothing can rewrite a tier at runtime", () => {
    expect(Object.isFrozen(ADMIN_ROUTE_POLICY)).toBe(true);
    expect(Object.isFrozen(ROLE_LEVEL)).toBe(true);
  });
});
