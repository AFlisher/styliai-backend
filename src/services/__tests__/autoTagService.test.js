const mockGenerateContent = jest.fn();

jest.mock("@google/genai", () => ({
  GoogleGenAI: jest.fn().mockImplementation(() => ({
    models: { generateContent: mockGenerateContent },
  })),
  Type: { OBJECT: "OBJECT", ARRAY: "ARRAY", STRING: "STRING" },
}));

jest.mock("../../models/tagModel", () => ({
  slugify: jest.fn((name) =>
    name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  ),
  getAllTags: jest.fn(),
  getTagBySlug: jest.fn(),
  createTag: jest.fn(),
}));

const tagModel = require("../../models/tagModel");
const autoTagService = require("../autoTagService");

const TAGS = [
  { id: "t1", name: "Cyberpunk", slug: "cyberpunk", isEnabled: true },
  { id: "t2", name: "Neon", slug: "neon", isEnabled: true },
  { id: "t3", name: "Sci-Fi", slug: "sci-fi", isEnabled: true },
  { id: "t4", name: "Retired Tag", slug: "retired-tag", isEnabled: false },
];

function mockResponseText(obj) {
  mockGenerateContent.mockResolvedValueOnce({ text: JSON.stringify(obj) });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GEMINI_API_KEY = "test-key";
  tagModel.getAllTags.mockResolvedValue(TAGS);
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  console.error.mockRestore();
});

describe("suggestTagsForStyle", () => {
  it("matches tag names case-insensitively and drops anything not in the vocabulary", async () => {
    mockResponseText({ tagNames: ["cyberpunk", "NEON", "Not A Real Tag"], newTagSuggestion: null });

    const result = await autoTagService.suggestTagsForStyle({
      name: "Cyberpunk mercenary",
      prompt: "Mercenario callejero en Neo-Tokyo...",
      categoryName: "Fantasy",
    });

    expect(result.status).toBe("ok");
    expect(result.tagIds.sort()).toEqual(["t1", "t2"].sort());
  });

  it("excludes disabled tags from both the prompt context and from matching", async () => {
    mockResponseText({ tagNames: ["Retired Tag", "Cyberpunk"], newTagSuggestion: null });

    const result = await autoTagService.suggestTagsForStyle({
      name: "Something",
      prompt: "prompt text",
      categoryName: "Fantasy",
    });

    expect(result.tagIds).toEqual(["t1"]);
    const promptSent = mockGenerateContent.mock.calls[0][0].contents[0].parts[0].text;
    expect(promptSent).not.toContain("Retired Tag");
  });

  it("caps matched tags at the max count", async () => {
    const manyTags = Array.from({ length: 10 }, (_, i) => ({
      id: `x${i}`,
      name: `Tag${i}`,
      slug: `tag${i}`,
      isEnabled: true,
    }));
    tagModel.getAllTags.mockResolvedValue(manyTags);
    mockResponseText({ tagNames: manyTags.map((t) => t.name), newTagSuggestion: null });

    const result = await autoTagService.suggestTagsForStyle({ name: "n", prompt: "p", categoryName: "c" });

    expect(result.tagIds.length).toBeLessThanOrEqual(6);
  });

  it("creates a new tag only when nothing in the vocabulary matched", async () => {
    mockResponseText({ tagNames: [], newTagSuggestion: "Underwater Portrait" });
    tagModel.createTag.mockResolvedValue({ id: "new1", name: "Underwater Portrait", slug: "underwater-portrait" });

    const result = await autoTagService.suggestTagsForStyle({ name: "n", prompt: "p", categoryName: "c" });

    expect(tagModel.createTag).toHaveBeenCalledWith({ name: "Underwater Portrait", isEnabled: true });
    expect(result.tagIds).toEqual(["new1"]);
    expect(result.status).toBe("ok");
  });

  it("reuses an existing tag via fuzzy slug match instead of creating a near-duplicate", async () => {
    mockResponseText({ tagNames: [], newTagSuggestion: "Sci Fi" }); // slugifies to "sci-fi", fuzzy-matches existing "sci-fi"

    const result = await autoTagService.suggestTagsForStyle({ name: "n", prompt: "p", categoryName: "c" });

    expect(tagModel.createTag).not.toHaveBeenCalled();
    expect(result.tagIds).toEqual(["t3"]);
  });

  it("reuses an existing tag on a create-time slug collision (23505) instead of erroring", async () => {
    mockResponseText({ tagNames: [], newTagSuggestion: "Totally New Concept" });
    const conflictErr = new Error("duplicate key value violates unique constraint");
    conflictErr.code = "23505";
    tagModel.createTag.mockRejectedValue(conflictErr);
    tagModel.getTagBySlug.mockResolvedValue({ id: "existing1", name: "Totally New Concept", slug: "totally-new-concept" });

    const result = await autoTagService.suggestTagsForStyle({ name: "n", prompt: "p", categoryName: "c" });

    expect(result.tagIds).toEqual(["existing1"]);
    expect(result.status).toBe("ok");
  });

  it("returns status 'empty' when nothing matches and no new-tag suggestion is given", async () => {
    mockResponseText({ tagNames: [], newTagSuggestion: null });

    const result = await autoTagService.suggestTagsForStyle({ name: "n", prompt: "p", categoryName: "c" });

    expect(result).toEqual({ tagIds: [], status: "empty" });
  });

  it("never throws when Gemini errors - returns status 'error' with empty tagIds", async () => {
    mockGenerateContent.mockRejectedValueOnce(new Error("network blip"));

    const result = await autoTagService.suggestTagsForStyle({ name: "n", prompt: "p", categoryName: "c" });

    expect(result.status).toBe("error");
    expect(result.tagIds).toEqual([]);
  });

  it("never throws on malformed JSON output", async () => {
    mockGenerateContent.mockResolvedValueOnce({ text: "not valid json" });

    const result = await autoTagService.suggestTagsForStyle({ name: "n", prompt: "p", categoryName: "c" });

    expect(result.status).toBe("error");
    expect(result.tagIds).toEqual([]);
  });

  it("never throws when Gemini returns an empty response", async () => {
    mockGenerateContent.mockResolvedValueOnce({ text: "" });

    const result = await autoTagService.suggestTagsForStyle({ name: "n", prompt: "p", categoryName: "c" });

    expect(result.status).toBe("error");
  });

  it("returns 'empty' immediately when there are no enabled tags at all, without calling Gemini", async () => {
    tagModel.getAllTags.mockResolvedValue([{ id: "t4", name: "Retired Tag", slug: "retired-tag", isEnabled: false }]);

    const result = await autoTagService.suggestTagsForStyle({ name: "n", prompt: "p", categoryName: "c" });

    expect(result).toEqual({ tagIds: [], status: "empty" });
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });
});
