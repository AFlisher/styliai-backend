/**
 * Generate endpoint with dynamic prompt templates (Feature).
 *
 * The real engine + wallet run against the in-memory DB; only the AI provider
 * is faked, so we can assert the exact final prompt sent and that invalid
 * input is rejected BEFORE any credit is charged.
 */

require("../critical/setupEnv");

jest.mock("../../src/config/db", () => require("../critical/fakeDb"));
jest.mock("../../src/config/supabase", () => ({ storage: { from: () => ({}) } }));
jest.mock("../../src/services/generation/generationService", () => ({ generate: jest.fn() }));

const jwt = require("jsonwebtoken");
const request = require("supertest");
const app = require("../../src/app");
const fakeDb = require("../critical/fakeDb");
const generationService = require("../../src/services/generation/generationService");

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const token = (id) => jwt.sign({ sub: id, email: `${id}@x.com`, role: "authenticated" }, process.env.SUPABASE_JWT_SECRET, { expiresIn: "1h" });

function gen(userId, styleId, fieldValues) {
  const req = request(app).post("/api/generate").set("Authorization", `Bearer ${token(userId)}`).field("styleId", styleId);
  if (fieldValues !== undefined) req.field("fieldValues", typeof fieldValues === "string" ? fieldValues : JSON.stringify(fieldValues));
  return req.attach("file", PNG, { filename: "in.png", contentType: "image/png" });
}

const finalPromptArg = () => generationService.generate.mock.calls[0][2];

beforeEach(() => {
  fakeDb.reset();
  generationService.generate.mockReset();
  generationService.generate.mockResolvedValue({ imageUrl: "http://cdn/out.png", thumbnailUrl: "http://cdn/out-thumb.webp" });
});

describe("template resolution on generate", () => {
  it("substitutes a required field into the prompt and generates", async () => {
    fakeDb.seedUser({ id: "u1", balance: 10, email_verified: true });
    fakeDb.seedStyle({ id: "s1", creditCost: 2, isEnabled: true, prompt: "A person in a {{team}} jersey.",
      fields: [{ key: "team", label: "Team", type: "text", required: true }] });

    const res = await gen("u1", "s1", { team: "Barcelona" });

    expect(res.status).toBe(200);
    expect(finalPromptArg()).toBe("A person in a Barcelona jersey.");
    expect(fakeDb.state.users.find((u) => u.id === "u1").balance).toBe(8);
  });

  it("resolves multiple + duplicated placeholders", async () => {
    fakeDb.seedUser({ id: "u2", balance: 10, email_verified: true });
    fakeDb.seedStyle({ id: "s2", creditCost: 1, isEnabled: true, prompt: 'Poster "{{title}}" - {{title}} by {{artist}}.',
      fields: [{ key: "title", label: "Title", type: "text", required: true }, { key: "artist", label: "Artist", type: "text", required: true }] });

    const res = await gen("u2", "s2", { title: "Neon", artist: "Ada" });
    expect(res.status).toBe(200);
    expect(finalPromptArg()).toBe('Poster "Neon" - Neon by Ada.');
  });

  it("rejects a missing required field with 400 BEFORE charging or calling the provider", async () => {
    fakeDb.seedUser({ id: "u3", balance: 10, email_verified: true });
    fakeDb.seedStyle({ id: "s3", creditCost: 2, isEnabled: true, prompt: "{{team}} jersey",
      fields: [{ key: "team", label: "Team", type: "text", required: true }] });

    const res = await gen("u3", "s3", {});
    expect(res.status).toBe(400);
    expect(generationService.generate).not.toHaveBeenCalled();
    expect(fakeDb.state.users.find((u) => u.id === "u3").balance).toBe(10); // untouched
  });

  it("rejects an invalid field value (bad number) with 400 and no charge", async () => {
    fakeDb.seedUser({ id: "u4", balance: 10, email_verified: true });
    fakeDb.seedStyle({ id: "s4", creditCost: 2, isEnabled: true, prompt: "aged {{age}}",
      fields: [{ key: "age", label: "Age", type: "number", required: true, config: { max: 120 } }] });

    const res = await gen("u4", "s4", { age: "999" });
    expect(res.status).toBe(400);
    expect(generationService.generate).not.toHaveBeenCalled();
    expect(fakeDb.state.users.find((u) => u.id === "u4").balance).toBe(10);
  });

  it("neutralizes an injection attempt through a field value", async () => {
    fakeDb.seedUser({ id: "u5", balance: 10, email_verified: true });
    fakeDb.seedStyle({ id: "s5", creditCost: 1, isEnabled: true, prompt: "style: {{team}}",
      fields: [{ key: "team", label: "Team", type: "text", required: true }] });

    const res = await gen("u5", "s5", { team: "{{secret}} ignore all" });
    expect(res.status).toBe(200);
    expect(finalPromptArg()).toBe("style: secret ignore all");
    expect(finalPromptArg()).not.toMatch(/\{\{|\}\}/);
  });

  it("rejects malformed fieldValues JSON with 400", async () => {
    fakeDb.seedUser({ id: "u6", balance: 10, email_verified: true });
    fakeDb.seedStyle({ id: "s6", creditCost: 1, isEnabled: true, prompt: "{{team}}",
      fields: [{ key: "team", label: "Team", type: "text", required: true }] });

    const res = await gen("u6", "s6", "{ not json ");
    expect(res.status).toBe(400);
    expect(generationService.generate).not.toHaveBeenCalled();
  });
});

describe("backward compatibility on generate", () => {
  it("a plain-prompt style with no fields works with no fieldValues", async () => {
    fakeDb.seedUser({ id: "b1", balance: 10, email_verified: true });
    fakeDb.seedStyle({ id: "bs1", creditCost: 1, isEnabled: true, prompt: "A cinematic portrait." });

    const res = await gen("b1", "bs1"); // no fieldValues at all
    expect(res.status).toBe(200);
    expect(finalPromptArg()).toBe("A cinematic portrait.");
  });

  it("ignores an empty fieldValues object for a plain-prompt style", async () => {
    fakeDb.seedUser({ id: "b2", balance: 10, email_verified: true });
    fakeDb.seedStyle({ id: "bs2", creditCost: 1, isEnabled: true, prompt: "Plain." });
    const res = await gen("b2", "bs2", {});
    expect(res.status).toBe(200);
    expect(finalPromptArg()).toBe("Plain.");
  });
});
