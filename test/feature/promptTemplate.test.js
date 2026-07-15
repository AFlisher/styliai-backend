/**
 * Prompt Template Engine unit tests (Feature: Dynamic Prompt Templates).
 * Covers: replacement, missing fields, unknown placeholders, duplicate
 * placeholders, escaping/injection, per-type validation, and backward compat.
 */

const {
  buildFinalPrompt,
  extractPlaceholders,
  validateFieldDefinition,
  assertUniqueKeys,
  PromptValidationError,
} = require("../../src/utils/promptTemplate");

const F = {
  team: { key: "team", label: "Team", type: "text", required: true },
  optional: { key: "note", label: "Note", type: "text", required: false },
};

describe("extractPlaceholders", () => {
  it("finds distinct keys and ignores malformed braces", () => {
    const keys = extractPlaceholders("{{team}} vs {{team}} in {{ city }} { not } {{}}");
    expect([...keys].sort()).toEqual(["city", "team"]);
  });
  it("returns empty for a plain prompt", () => {
    expect(extractPlaceholders("no tokens here").size).toBe(0);
  });
});

describe("backward compatibility", () => {
  it("returns a plain prompt unchanged with no fields", () => {
    expect(buildFinalPrompt({ prompt: "A realistic portrait.", fields: [], values: {} })).toBe("A realistic portrait.");
  });
  it("handles an empty/undefined prompt", () => {
    expect(buildFinalPrompt({ prompt: "", fields: [], values: {} })).toBe("");
    expect(buildFinalPrompt({})).toBe("");
  });
});

describe("placeholder replacement", () => {
  it("substitutes a single placeholder", () => {
    expect(buildFinalPrompt({ prompt: "Wearing a {{team}} jersey.", fields: [F.team], values: { team: "Barcelona" } }))
      .toBe("Wearing a Barcelona jersey.");
  });
  it("replaces every occurrence of a duplicated placeholder", () => {
    expect(buildFinalPrompt({ prompt: "{{team}}! Go {{team}}!", fields: [F.team], values: { team: "Madrid" } }))
      .toBe("Madrid! Go Madrid!");
  });
  it("resolves an optional blank field to empty string (no residual token)", () => {
    expect(buildFinalPrompt({ prompt: "Portrait {{note}}.", fields: [F.optional], values: {} })).toBe("Portrait .");
  });
  it("uses a configured default for an optional blank field", () => {
    const f = { key: "mood", label: "Mood", type: "text", required: false, config: { default: "happy" } };
    expect(buildFinalPrompt({ prompt: "A {{mood}} face.", fields: [f], values: {} })).toBe("A happy face.");
  });
});

describe("missing required fields", () => {
  it("rejects a missing required value", () => {
    expect(() => buildFinalPrompt({ prompt: "{{team}}", fields: [F.team], values: {} }))
      .toThrow(PromptValidationError);
  });
  it("rejects a whitespace-only required value", () => {
    expect(() => buildFinalPrompt({ prompt: "{{team}}", fields: [F.team], values: { team: "   " } }))
      .toThrow(/required/i);
  });
});

describe("unknown placeholders / fields", () => {
  it("rejects a placeholder with no configured field", () => {
    expect(() => buildFinalPrompt({ prompt: "{{ghost}}", fields: [], values: {} }))
      .toThrow(/unknown placeholder/i);
  });
  it("rejects a submitted value for an undefined field (never trust client)", () => {
    expect(() => buildFinalPrompt({ prompt: "{{team}}", fields: [F.team], values: { team: "X", evil: "y" } }))
      .toThrow(/unknown field/i);
  });
});

describe("escaping / injection prevention", () => {
  it("strips braces so a value cannot inject a new placeholder", () => {
    expect(buildFinalPrompt({ prompt: "{{team}}", fields: [F.team], values: { team: "{{admin}}" } }))
      .toBe("admin");
  });
  it("neutralizes a value that tries to reopen the template", () => {
    const out = buildFinalPrompt({ prompt: "a {{team}} b", fields: [F.team], values: { team: "}} {{secret" } });
    expect(out).not.toMatch(/\{\{|\}\}/);
  });
  it("collapses newlines/tabs and does not keep control characters", () => {
    const out = buildFinalPrompt({ prompt: "{{team}}", fields: [F.team], values: { team: "a\n\tb c" } });
    expect(out).toBe("a b c");
  });
  it("treats $ in a value literally (no regex group interpretation)", () => {
    expect(buildFinalPrompt({ prompt: "{{team}}", fields: [F.team], values: { team: "$1 $& price" } }))
      .toBe("$1 $& price");
  });
  it("enforces a max length", () => {
    const f = { key: "team", label: "Team", type: "text", required: true, config: { maxLength: 5 } };
    expect(buildFinalPrompt({ prompt: "{{team}}", fields: [f], values: { team: "abcdefghij" } })).toBe("abcde");
  });
});

describe("field-type validation", () => {
  it("number: coerces valid, enforces min/max, rejects non-numeric", () => {
    const f = { key: "age", label: "Age", type: "number", required: true, config: { min: 1, max: 120 } };
    expect(buildFinalPrompt({ prompt: "{{age}}", fields: [f], values: { age: "30" } })).toBe("30");
    expect(() => buildFinalPrompt({ prompt: "{{age}}", fields: [f], values: { age: "999" } })).toThrow(/at most/i);
    expect(() => buildFinalPrompt({ prompt: "{{age}}", fields: [f], values: { age: "x" } })).toThrow(/must be a number/i);
  });
  it("dropdown: accepts an allowed option, rejects others", () => {
    const f = { key: "size", label: "Size", type: "dropdown", required: true, options: ["S", "M", "L"] };
    expect(buildFinalPrompt({ prompt: "{{size}}", fields: [f], values: { size: "M" } })).toBe("M");
    expect(() => buildFinalPrompt({ prompt: "{{size}}", fields: [f], values: { size: "XL" } })).toThrow(/allowed options/i);
  });
  it("checkbox: renders configured true/false text", () => {
    const f = { key: "vintage", label: "Vintage", type: "checkbox", required: false, config: { trueText: "vintage", falseText: "modern" } };
    expect(buildFinalPrompt({ prompt: "a {{vintage}} look", fields: [f], values: { vintage: true } })).toBe("a vintage look");
    expect(buildFinalPrompt({ prompt: "a {{vintage}} look", fields: [f], values: { vintage: false } })).toBe("a modern look");
  });
  it("color: accepts hex, rejects invalid", () => {
    const f = { key: "hue", label: "Hue", type: "color", required: true };
    expect(buildFinalPrompt({ prompt: "{{hue}}", fields: [f], values: { hue: "#A855F7" } })).toBe("#A855F7");
    expect(() => buildFinalPrompt({ prompt: "{{hue}}", fields: [f], values: { hue: "purple" } })).toThrow(/hex color/i);
  });
  it("date: accepts YYYY-MM-DD, rejects invalid", () => {
    const f = { key: "day", label: "Day", type: "date", required: true };
    expect(buildFinalPrompt({ prompt: "{{day}}", fields: [f], values: { day: "2026-07-15" } })).toBe("2026-07-15");
    expect(() => buildFinalPrompt({ prompt: "{{day}}", fields: [f], values: { day: "15/07/2026" } })).toThrow(/valid date/i);
  });
});

describe("field definition validation (admin save)", () => {
  it("accepts a valid definition", () => {
    expect(validateFieldDefinition({ key: "team", label: "Team", type: "text" })).toBe(true);
  });
  it("rejects a bad key", () => {
    expect(() => validateFieldDefinition({ key: "Team Name", label: "x", type: "text" })).toThrow(/lower_snake_case/i);
  });
  it("rejects a dropdown with no options", () => {
    expect(() => validateFieldDefinition({ key: "size", label: "Size", type: "dropdown", options: [] })).toThrow(/at least one option/i);
  });
  it("rejects duplicate keys in a set", () => {
    expect(() => assertUniqueKeys([
      { key: "team", label: "A", type: "text" },
      { key: "team", label: "B", type: "text" },
    ])).toThrow(/duplicate/i);
  });
});
