/**
 * Medium-priority secrets-hygiene suite (QA_TEST_PLAN.md):
 *   SEC-015 (no hardcoded secrets in application source)
 *
 * A static guard: application code must read every secret from the
 * environment, never embed a literal key/token/connection-string. This runs
 * with no app dependencies - it just scans src/.
 */

const fs = require("fs");
const path = require("path");

const SRC_DIR = path.resolve(__dirname, "../../src");

// Patterns for real credential material. Deliberately narrow to avoid false
// positives on ordinary code (e.g. the word "password" in a column name).
const SECRET_PATTERNS = [
  { name: "OpenAI-style key", re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_\-]{35}\b/ },
  { name: "Resend key", re: /\bre_[A-Za-z0-9]{16,}\b/ },
  { name: "JWT literal", re: /\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\b/ },
  { name: "Postgres URL with password", re: /postgres(?:ql)?:\/\/[^\s:'"]+:[^\s@'"]+@/ },
  { name: "Supabase service_role literal", re: /service_role.{0,40}eyJ/ },
];

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__tests__") continue;
      out.push(...walk(full));
    } else if (/\.js$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe("SEC-015 — no hardcoded secrets in application source", () => {
  const files = walk(SRC_DIR);

  it("scans a non-trivial number of source files", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(files.map((f) => [path.relative(SRC_DIR, f), f]))("%s contains no embedded credentials", (_rel, file) => {
    const content = fs.readFileSync(file, "utf8");
    for (const { name, re } of SECRET_PATTERNS) {
      expect(content).not.toMatch(new RegExp(re.source));
      if (re.test(content)) throw new Error(`Possible ${name} in ${file}`);
    }
  });
});
