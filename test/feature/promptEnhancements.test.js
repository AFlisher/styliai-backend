/**
 * Prompt-template enhancements (Feature follow-up):
 *   - rich field validation (minLength / regex; min/max already covered)
 *   - save-time rejection of prompts with unbacked placeholders
 *   - admin-only live prompt-preview endpoint
 */

require("../critical/setupEnv");

jest.mock("../../src/config/db", () => require("../critical/fakeDb"));
jest.mock("../../src/config/supabase", () => ({ storage: { from: () => ({}) } }));

const { buildFinalPrompt, validatePromptFields, PromptValidationError } = require("../../src/utils/promptTemplate");

describe("rich field validation (engine)", () => {
  it("enforces minLength on text", () => {
    const f = { key: "team", label: "Team", type: "text", required: true, config: { minLength: 3 } };
    expect(() => buildFinalPrompt({ prompt: "{{team}}", fields: [f], values: { team: "ab" } })).toThrow(/at least 3 characters/i);
    expect(buildFinalPrompt({ prompt: "{{team}}", fields: [f], values: { team: "abc" } })).toBe("abc");
  });

  it("enforces a regex pattern on text", () => {
    const f = { key: "code", label: "Code", type: "text", required: true, config: { regex: "^[A-Z]{3}$" } };
    expect(() => buildFinalPrompt({ prompt: "{{code}}", fields: [f], values: { code: "ab" } })).toThrow(/expected format/i);
    expect(buildFinalPrompt({ prompt: "{{code}}", fields: [f], values: { code: "ABC" } })).toBe("ABC");
  });

  it("ignores a malformed admin regex instead of crashing", () => {
    const f = { key: "x", label: "X", type: "text", required: false, config: { regex: "([" } };
    expect(buildFinalPrompt({ prompt: "{{x}}", fields: [f], values: { x: "anything" } })).toBe("anything");
  });
});

describe("validatePromptFields", () => {
  it("passes when every placeholder has a field", () => {
    expect(validatePromptFields("{{team}} {{city}}", [
      { key: "team", label: "T", type: "text" },
      { key: "city", label: "C", type: "text" },
    ])).toBe(true);
  });

  it("throws listing placeholders with no matching field", () => {
    expect(() => validatePromptFields("{{team}}", [{ key: "country", label: "C", type: "text" }]))
      .toThrow(/no matching field.*\{\{team\}\}/i);
  });

  it("allows an unused field (defined but not referenced)", () => {
    expect(validatePromptFields("{{team}}", [
      { key: "team", label: "T", type: "text" },
      { key: "extra", label: "E", type: "text" },
    ])).toBe(true);
  });
});

// ---- HTTP layer: save enforcement + preview endpoint ----

jest.mock("../../src/models/styleModel", () => ({ createStyle: jest.fn(), updateStyle: jest.fn() }));
jest.mock("../../src/services/recommendationService", () => ({ invalidateCandidateCache: jest.fn(), getSimilarStyles: jest.fn() }));

const jwt = require("jsonwebtoken");
const request = require("supertest");
const app = require("../../src/app");
const styleModel = require("../../src/models/styleModel");

const adminToken = () => jwt.sign({ sub: "admin-1", email: "a@x.com", role: "admin" }, process.env.ADMIN_JWT_SECRET, { expiresIn: "2h" });

beforeEach(() => jest.clearAllMocks());

describe("save is blocked when the prompt has an unbacked placeholder", () => {
  it("rejects create with 400 and does not touch the model", async () => {
    const res = await request(app).post("/api/styles").set("Authorization", `Bearer ${adminToken()}`).send({
      categoryId: "c1", name: "Jersey", prompt: "A {{team}} jersey", autoAssignTags: false,
      fields: [{ key: "country", label: "Country", type: "text", required: true }],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/\{\{team\}\}/);
    expect(styleModel.createStyle).not.toHaveBeenCalled();
  });

  it("allows create when every placeholder is backed (unused field is fine)", async () => {
    styleModel.createStyle.mockResolvedValue({ id: "s1" });
    const res = await request(app).post("/api/styles").set("Authorization", `Bearer ${adminToken()}`).send({
      categoryId: "c1", name: "Jersey", prompt: "A {{team}} jersey", autoAssignTags: false,
      fields: [
        { key: "team", label: "Team", type: "text", required: true },
        { key: "note", label: "Note", type: "text", required: false }, // unused -> allowed
      ],
    });
    expect(res.status).toBe(201);
  });
});

describe("POST /api/styles/prompt-preview (admin-only)", () => {
  const body = {
    prompt: 'Poster "{{title}}" in {{color}}',
    fields: [
      { key: "title", label: "Title", type: "text", required: true },
      { key: "color", label: "Color", type: "color", required: true },
    ],
    values: { title: "Neon", color: "#A855F7" },
  };

  it("renders the final prompt exactly as generation would", async () => {
    const res = await request(app).post("/api/styles/prompt-preview").set("Authorization", `Bearer ${adminToken()}`).send(body);
    expect(res.status).toBe(200);
    expect(res.body.prompt).toBe('Poster "Neon" in #A855F7');
  });

  it("returns 400 for invalid sample values (bad color)", async () => {
    const res = await request(app).post("/api/styles/prompt-preview").set("Authorization", `Bearer ${adminToken()}`)
      .send({ ...body, values: { title: "X", color: "purple" } });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/hex color/i);
  });

  it("requires an admin token (never exposes prompt rendering publicly)", async () => {
    const res = await request(app).post("/api/styles/prompt-preview").send(body);
    expect([401, 403]).toContain(res.status);
  });

  it("is not shadowed by the /:id route", async () => {
    // Ensures 'prompt-preview' reaches previewPrompt, not updateStyle/:id.
    const res = await request(app).post("/api/styles/prompt-preview").set("Authorization", `Bearer ${adminToken()}`)
      .send({ prompt: "plain", fields: [], values: {} });
    expect(res.status).toBe(200);
    expect(res.body.prompt).toBe("plain");
  });
});
