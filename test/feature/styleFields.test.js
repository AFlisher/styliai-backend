/**
 * Style fields: model round-trip + admin controller contract (Feature).
 */

require("../critical/setupEnv");

jest.mock("../../src/config/db", () => require("../critical/fakeDb"));
jest.mock("../../src/config/supabase", () => ({ storage: { from: () => ({}) } }));

const fakeDb = require("../critical/fakeDb");
const styleFieldsModel = require("../../src/models/styleFieldsModel");

beforeEach(() => {
  fakeDb.reset();
  jest.clearAllMocks();
});

describe("styleFieldsModel round-trip", () => {
  it("persists fields via replaceFields and reads them back ordered", async () => {
    const client = await fakeDb.pool.connect();
    await styleFieldsModel.replaceFields(client, "style-1", [
      { key: "team", label: "Team", type: "text", required: true, placeholder: "Barcelona", sortOrder: 1 },
      { key: "size", label: "Size", type: "dropdown", required: false, options: ["S", "M", "L"], sortOrder: 0 },
    ]);

    const fields = await styleFieldsModel.getFieldsForStyle("style-1");
    expect(fields.map((f) => f.key)).toEqual(["size", "team"]); // sort_order asc
    const size = fields.find((f) => f.key === "size");
    expect(size.type).toBe("dropdown");
    expect(size.options).toEqual([{ value: "S", label: "S" }, { value: "M", label: "M" }, { value: "L", label: "L" }]);
    const team = fields.find((f) => f.key === "team");
    expect(team.required).toBe(true);
    expect(team.placeholder).toBe("Barcelona");
  });

  it("replaceFields clears existing fields when passed an empty array", async () => {
    const client = await fakeDb.pool.connect();
    await styleFieldsModel.replaceFields(client, "style-2", [{ key: "a", label: "A", type: "text" }]);
    await styleFieldsModel.replaceFields(client, "style-2", []);
    expect(await styleFieldsModel.getFieldsForStyle("style-2")).toEqual([]);
  });

  it("rejects duplicate keys and invalid definitions before writing", async () => {
    const client = await fakeDb.pool.connect();
    await expect(
      styleFieldsModel.replaceFields(client, "s", [
        { key: "team", label: "A", type: "text" },
        { key: "team", label: "B", type: "text" },
      ])
    ).rejects.toThrow(/duplicate/i);
    await expect(
      styleFieldsModel.replaceFields(client, "s", [{ key: "Bad Key", label: "X", type: "text" }])
    ).rejects.toThrow(/lower_snake_case/i);
  });

  it("batches fields for multiple styles (no N+1)", async () => {
    const client = await fakeDb.pool.connect();
    await styleFieldsModel.replaceFields(client, "sa", [{ key: "x", label: "X", type: "text" }]);
    await styleFieldsModel.replaceFields(client, "sb", [{ key: "y", label: "Y", type: "text" }]);
    const map = await styleFieldsModel.getFieldsForStyleIds(["sa", "sb"]);
    expect(map.get("sa")[0].key).toBe("x");
    expect(map.get("sb")[0].key).toBe("y");
  });
});

// --- Admin controller contract: fields are forwarded + validated (400) ---

jest.mock("../../src/models/styleModel", () => ({
  createStyle: jest.fn(),
  updateStyle: jest.fn(),
}));
jest.mock("../../src/services/recommendationService", () => ({ invalidateCandidateCache: jest.fn(), getSimilarStyles: jest.fn() }));

const jwt = require("jsonwebtoken");
const request = require("supertest");
const app = require("../../src/app");
const styleModel = require("../../src/models/styleModel");

const adminToken = () => jwt.sign({ sub: "admin-1", email: "a@x.com", role: "admin" }, process.env.ADMIN_JWT_SECRET, { expiresIn: "2h" });
const base = { categoryId: "c1", name: "Football Jersey", prompt: "Wearing a {{team}} jersey.", autoAssignTags: false };

describe("admin create style with fields", () => {
  it("forwards a valid fields array to the model and returns 201", async () => {
    styleModel.createStyle.mockResolvedValue({ id: "new", fields: [{ key: "team" }] });
    const res = await request(app).post("/api/styles").set("Authorization", `Bearer ${adminToken()}`).send({
      ...base,
      fields: [{ key: "team", label: "Team", type: "text", required: true, placeholder: "Barcelona" }],
    });
    expect(res.status).toBe(201);
    expect(styleModel.createStyle.mock.calls[0][0].fields[0].key).toBe("team");
  });

  it("rejects duplicate field keys with 400 before any DB write", async () => {
    const res = await request(app).post("/api/styles").set("Authorization", `Bearer ${adminToken()}`).send({
      ...base,
      fields: [
        { key: "team", label: "A", type: "text" },
        { key: "team", label: "B", type: "text" },
      ],
    });
    expect(res.status).toBe(400);
    expect(styleModel.createStyle).not.toHaveBeenCalled();
  });

  it("rejects a dropdown field with no options (400)", async () => {
    const res = await request(app).post("/api/styles").set("Authorization", `Bearer ${adminToken()}`).send({
      ...base,
      fields: [{ key: "size", label: "Size", type: "dropdown", options: [] }],
    });
    expect(res.status).toBe(400);
    expect(styleModel.createStyle).not.toHaveBeenCalled();
  });

  it("rejects a non-array fields value (400)", async () => {
    const res = await request(app).post("/api/styles").set("Authorization", `Bearer ${adminToken()}`).send({ ...base, fields: "nope" });
    expect(res.status).toBe(400);
  });

  it("still works with no fields (backward compatible)", async () => {
    styleModel.createStyle.mockResolvedValue({ id: "new" });
    const res = await request(app).post("/api/styles").set("Authorization", `Bearer ${adminToken()}`).send({
      categoryId: "c1", name: "Plain", prompt: "A plain prompt.", autoAssignTags: false,
    });
    expect(res.status).toBe(201);
    expect(styleModel.createStyle.mock.calls[0][0].fields).toBeUndefined();
  });
});
