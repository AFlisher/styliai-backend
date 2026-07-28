// SEC-15.1: end-to-end proof that privileged admin actions land in
// admin_audit_log, against the REAL app rather than a stand-in router - so a
// future change that drops the middleware from app.js, or adds an admin route
// that bypasses it, fails here.
//
// The unit suites pin the pieces (models/__tests__/adminAuditModel.test.js for
// what gets stored, middleware/__tests__/auditAdminAction.test.js for the
// gating rules). This file pins that the wiring actually reaches the database
// on a real request, and that the two failure modes behave as designed:
// fail-open for catalog edits, fail-closed for money.

process.env.ADMIN_JWT_SECRET = "test-only-secret-never-used-in-production";

jest.mock("../config/db", () => ({
  query: jest.fn(),
  pool: { connect: jest.fn() },
}));

const request = require("supertest");
const jwt = require("jsonwebtoken");
const db = require("../config/db");
const app = require("../app");

const ADMIN = { id: "11111111-1111-1111-1111-111111111111", email: "admin@example.com" };
const TARGET_USER = "22222222-2222-2222-2222-222222222222";

function adminToken() {
  return jwt.sign({ sub: ADMIN.id, email: ADMIN.email, role: "admin" }, process.env.ADMIN_JWT_SECRET, {
    algorithm: "HS256",
    expiresIn: "5m",
  });
}

/**
 * The audit write is dispatched from the response 'finish' event and is not
 * awaited by the handler, so it can still be in flight when supertest resolves.
 */
async function flush() {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Every admin_audit_log INSERT the app made, as `{ sql, params }`. */
function auditWrites(queryFn = db.query) {
  return queryFn.mock.calls
    .filter(([sql]) => typeof sql === "string" && sql.includes("INSERT INTO admin_audit_log"))
    .map(([sql, params]) => ({ sql, params }));
}

/** Column order matches adminAuditModel.INSERT_SQL. */
function asEntry(params) {
  return {
    adminId: params[0],
    adminEmail: params[1],
    action: params[2],
    targetType: params[3],
    targetId: params[4],
    before: params[5] ? JSON.parse(params[5]) : null,
    after: params[6] ? JSON.parse(params[6]) : null,
    ip: params[7],
    requestUrl: params[8],
    statusCode: params[9],
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockResolvedValue({ rows: [], rowCount: 0 });
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  console.error.mockRestore();
  console.warn.mockRestore();
});

describe("catalog mutations are attributed (SEC-15.1)", () => {
  it("records a style deletion with the acting admin and the removed row", async () => {
    const removed = {
      id: "style-9",
      name: "Cyberpunk",
      prompt: "a neon portrait",
      credit_cost: 2,
      is_enabled: true,
    };
    // styleModel.deleteStyle's DELETE ... RETURNING * is the only read here.
    db.query.mockImplementation((sql) => {
      if (sql.includes("DELETE FROM styles")) return Promise.resolve({ rows: [removed], rowCount: 1 });
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const res = await request(app)
      .delete("/api/styles/style-9")
      .set("Authorization", `Bearer ${adminToken()}`);
    expect(res.status).toBe(204);

    await flush();

    const writes = auditWrites();
    expect(writes).toHaveLength(1);

    const entry = asEntry(writes[0].params);
    expect(entry.adminId).toBe(ADMIN.id);
    expect(entry.adminEmail).toBe(ADMIN.email);
    expect(entry.action).toBe("DELETE /api/styles/:id");
    expect(entry.targetType).toBe("styles");
    expect(entry.targetId).toBe("style-9");
    expect(entry.statusCode).toBe(204);
    // The whole point of RETURNING *: the deletion is reconstructable.
    expect(entry.before).toEqual(removed);
  });

  it("records the submitted payload as the intended after-state on a create", async () => {
    db.query.mockImplementation((sql) => {
      if (sql.includes("INSERT INTO tags")) {
        return Promise.resolve({ rows: [{ id: "tag-1", name: "Neon", slug: "neon" }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const res = await request(app)
      .post("/api/tags")
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({ name: "Neon" });
    expect(res.status).toBeLessThan(300);

    await flush();

    const entry = asEntry(auditWrites()[0].params);
    expect(entry.action).toBe("POST /api/tags");
    expect(entry.targetType).toBe("tags");
    expect(entry.after).toEqual({ name: "Neon" });
  });
});

describe("what never reaches the audit log", () => {
  it("writes nothing for an unauthenticated request", async () => {
    const res = await request(app).delete("/api/styles/style-9");
    expect(res.status).toBe(401);

    await flush();
    expect(auditWrites()).toHaveLength(0);
  });

  it("writes nothing for a request bearing an invalid admin token", async () => {
    const res = await request(app)
      .delete("/api/styles/style-9")
      .set("Authorization", "Bearer not-a-real-token");
    expect(res.status).toBe(401);

    await flush();
    expect(auditWrites()).toHaveLength(0);
  });

  it("never records the admin login body, which carries a password", async () => {
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });

    const res = await request(app)
      .post("/api/admin/login")
      .send({ email: "admin@example.com", password: "SENTINEL-PASSWORD" });
    expect(res.status).toBe(401);

    await flush();

    expect(auditWrites()).toHaveLength(0);
    // Nothing anywhere in the DB traffic should carry the password.
    const allParams = JSON.stringify(db.query.mock.calls);
    expect(allParams).not.toContain("SENTINEL-PASSWORD");
  });

  it("writes nothing for a read, even with a valid admin token", async () => {
    const res = await request(app)
      .get("/api/tags")
      .set("Authorization", `Bearer ${adminToken()}`);
    expect(res.status).toBe(200);

    await flush();
    expect(auditWrites()).toHaveLength(0);
  });
});

describe("fail-open: a catalog edit is not undone by an audit failure", () => {
  it("still answers 204 when the audit insert fails", async () => {
    db.query.mockImplementation((sql) => {
      if (sql.includes("INSERT INTO admin_audit_log")) {
        return Promise.reject(new Error('relation "admin_audit_log" does not exist'));
      }
      if (sql.includes("DELETE FROM styles")) {
        return Promise.resolve({ rows: [{ id: "style-9", name: "Cyberpunk" }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const res = await request(app)
      .delete("/api/styles/style-9")
      .set("Authorization", `Bearer ${adminToken()}`);

    // Refusing to serve an already-committed mutation would turn an
    // accountability gap into an availability outage.
    expect(res.status).toBe(204);

    await flush();
    // ...but the failure has to be loud, not silent.
    expect(console.error).toHaveBeenCalled();
    const logged = console.error.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("[audit]");
  });
});

describe("fail-closed: the money path (SEC-15.1)", () => {
  /** Mocks pool.connect() with a client whose queries are routed by SQL text. */
  function mockWalletClient({ auditFails = false, balance = 10 } = {}) {
    const client = {
      query: jest.fn((sql) => {
        if (sql.includes("INSERT INTO admin_audit_log")) {
          return auditFails
            ? Promise.reject(new Error("audit insert failed"))
            : Promise.resolve({ rows: [{ id: "audit-1" }] });
        }
        if (sql.includes("FOR UPDATE")) {
          return Promise.resolve({ rows: [{ balance }], rowCount: 1 });
        }
        return Promise.resolve({ rows: [{}], rowCount: 1 });
      }),
      release: jest.fn(),
    };
    db.pool.connect.mockResolvedValue(client);
    return client;
  }

  it("writes the audit row on the same transaction and stamps the admin on the ledger", async () => {
    const client = mockWalletClient({ balance: 10 });

    const res = await request(app)
      .post(`/api/admin/users/${TARGET_USER}/adjust-balance`)
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({ amount: 5, description: "goodwill credit" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ balance: 15 });

    await flush();

    // On the client, inside the transaction - not on the pool. If this ran on
    // db.query it would commit independently of the balance change.
    const onClient = auditWrites(client.query);
    expect(onClient).toHaveLength(1);
    expect(auditWrites(db.query)).toHaveLength(0);

    const entry = asEntry(onClient[0].params);
    expect(entry.adminId).toBe(ADMIN.id);
    expect(entry.action).toBe("POST /api/admin/users/:id/adjust-balance");
    expect(entry.targetId).toBe(TARGET_USER);
    // Real balances, read inside the row lock - not the submitted intent.
    expect(entry.before).toEqual({ balance: 10 });
    expect(entry.after).toMatchObject({ balance: 15, amount: 5 });

    // The ledger row now names the acting admin (SEC-15.1's second half).
    const ledger = client.query.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("INSERT INTO wallet_transactions")
    );
    expect(ledger).toBeDefined();
    expect(ledger[1]).toContain(ADMIN.id);

    // Committed exactly once, and never rolled back.
    const verbs = client.query.mock.calls
      .map(([sql]) => sql)
      .filter((sql) => sql === "COMMIT" || sql === "ROLLBACK");
    expect(verbs).toEqual(["COMMIT"]);
  });

  it("rolls the balance change back when the audit row cannot be written", async () => {
    const client = mockWalletClient({ auditFails: true, balance: 10 });

    const res = await request(app)
      .post(`/api/admin/users/${TARGET_USER}/adjust-balance`)
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({ amount: 5, description: "goodwill credit" });

    // Credits must not move without an attributable record.
    expect(res.status).toBe(500);

    await flush();

    const issued = client.query.mock.calls.map(([sql]) => sql);
    expect(issued).toContain("ROLLBACK");
    expect(issued).not.toContain("COMMIT");

    // And the fail-open middleware must not paper over it with a row of its own.
    expect(auditWrites(db.query)).toHaveLength(0);
  });
});
