// Covers audit finding #10: user-supplied names are escaped before being
// interpolated into HTML email bodies.

const escapeHtml = require("../escapeHtml");

describe("escapeHtml", () => {
  it("escapes all five HTML special characters", () => {
    expect(escapeHtml(`<img src=x onerror="alert('x')">&`)).toBe(
      "&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;"
    );
  });

  it("leaves ordinary names untouched", () => {
    expect(escapeHtml("Ahmed Ali")).toBe("Ahmed Ali");
  });

  it("stringifies null/undefined to an empty string instead of throwing", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });
});
