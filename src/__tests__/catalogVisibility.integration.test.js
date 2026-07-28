// SEC-15.6: end-to-end, against the REAL app and real route wiring.
//
// The controller unit tests assert which model function was called; these
// assert what a client actually RECEIVES, which is the property the finding is
// about. It also exercises optionalAdminAuth, so a change to how req.admin is
// established (as SEC-15.4 made) shows up here.

process.env.ADMIN_JWT_SECRET = "test-only-admin-secret";
process.env.SUPABASE_JWT_SECRET = "test-only-user-secret";

jest.mock("../config/db", () => ({
  query: jest.fn(),
  pool: { connect: jest.fn() },
}));

const request = require("supertest");
const jwt = require("jsonwebtoken");
const db = require("../config/db");
const app = require("../app");

const ENABLED_STYLE = { id: "s-on", name: "Released", isEnabled: true };
const DISABLED_STYLE = { id: "s-off", name: "UNRELEASED-SENTINEL", isEnabled: false };
const ENABLED_CAT = { id: "c-on", name: "Released", isEnabled: true };
const DISABLED_CAT = { id: "c-off", name: "UNRELEASED-CATEGORY-SENTINEL", isEnabled: false };

function userToken() {
  return jwt.sign(
    { sub: "00000000-0000-0000-0000-0000000000aa", email: "u@example.com", aud: "authenticated", type: "access" },
    process.env.SUPABASE_JWT_SECRET,
    { algorithm: "HS256", expiresIn: "5m" }
  );
}

function adminToken(adminRole = "viewer") {
  return jwt.sign(
    { sub: "admin-1", email: "a@example.com", role: "admin", adminRole },
    process.env.ADMIN_JWT_SECRET,
    { algorithm: "HS256", expiresIn: "5m" }
  );
}

/**
 * Answers the catalog queries from the fixtures above, honouring whatever
 * WHERE clause the model actually built - so if the controller stops asking
 * for `is_enabled = true`, the disabled row really does come back.
 */
function mockCatalog() {
  db.query.mockImplementation((sql, params = []) => {
    if (sql.includes("FROM categories")) {
      const rows = sql.includes("is_enabled = true")
        ? [ENABLED_CAT]
        : [ENABLED_CAT, DISABLED_CAT];
      return Promise.resolve({ rows, rowCount: rows.length });
    }
    if (sql.includes("FROM styles")) {
      const wantsEnabledOnly = sql.includes("is_enabled = $") && params.includes(true);
      const rows = wantsEnabledOnly ? [ENABLED_STYLE] : [ENABLED_STYLE, DISABLED_STYLE];
      return Promise.resolve({ rows, rowCount: rows.length });
    }
    // style_fields lookup from attachFields, and anything else.
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCatalog();
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => console.error.mockRestore());

describe("an ordinary user never receives disabled catalog rows", () => {
  it.each([
    ["/api/styles"],
    ["/api/styles?all=true"],
    ["/api/styles?all=true&trending=true"],
  ])("%s", async (path) => {
    const res = await request(app).get(path).set("Authorization", `Bearer ${userToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.some((s) => s.isEnabled === false)).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain("UNRELEASED-SENTINEL");
  });

  it("GET /api/categories", async () => {
    const res = await request(app).get("/api/categories").set("Authorization", `Bearer ${userToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.some((c) => c.isEnabled === false)).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain("UNRELEASED-CATEGORY-SENTINEL");
  });

  it("still receives the enabled rows - this is a filter, not a blanket denial", async () => {
    const styles = await request(app).get("/api/styles").set("Authorization", `Bearer ${userToken()}`);
    const cats = await request(app).get("/api/categories").set("Authorization", `Bearer ${userToken()}`);

    expect(styles.body).toHaveLength(1);
    expect(cats.body).toHaveLength(1);
  });

  it("keeps the response shape unchanged (no field added or removed)", async () => {
    const res = await request(app).get("/api/categories").set("Authorization", `Bearer ${userToken()}`);

    expect(Object.keys(res.body[0]).sort()).toEqual(Object.keys(ENABLED_CAT).sort());
  });
});

describe("an admin still receives them", () => {
  it("GET /api/styles?all=true includes disabled styles", async () => {
    const res = await request(app)
      .get("/api/styles?all=true")
      .set("Authorization", `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.some((s) => s.isEnabled === false)).toBe(true);
  });

  it("GET /api/categories includes disabled categories", async () => {
    const res = await request(app)
      .get("/api/categories")
      .set("Authorization", `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.some((c) => c.isEnabled === false)).toBe(true);
  });

  it.each([["viewer"], ["editor"], ["superadmin"]])(
    "works for a %s - catalog reads are viewer-tier",
    async (adminRole) => {
      const res = await request(app)
        .get("/api/categories")
        .set("Authorization", `Bearer ${adminToken(adminRole)}`);

      expect(res.status).toBe(200);
      expect(res.body.some((c) => c.isEnabled === false)).toBe(true);
    }
  );
});

describe("the gate is the token, not the request", () => {
  it("a forged admin token does not widen the view", async () => {
    const forged = jwt.sign(
      { sub: "x", role: "admin", adminRole: "superadmin" },
      "not-the-admin-secret",
      { algorithm: "HS256", expiresIn: "5m" }
    );

    // optionalAdminAuth ignores an unverifiable token, so this falls through to
    // the user path - and requireUserOrAdmin then rejects it outright.
    const res = await request(app).get("/api/categories").set("Authorization", `Bearer ${forged}`);

    expect(res.status).toBe(401);
  });

  it("an unauthenticated caller gets nothing at all", async () => {
    const res = await request(app).get("/api/styles?all=true");
    expect(res.status).toBe(401);
  });
});
