/**
 * Medium-priority secrets-hygiene suite (QA_TEST_PLAN.md):
 *   SEC-015   no hardcoded secrets in application source
 *   SEC-17.2  widened from src/**\/*.js to the whole tracked tree, and wired
 *             into CI so it stops depending on someone remembering to run it
 *
 * A static guard: nothing committed to this repository may embed a literal
 * key, token or connection string. It runs with no app dependencies.
 *
 * Scope is "every file git tracks", not "every file on disk". That is the
 * property actually worth asserting - an untracked local .env is the
 * developer's business, a committed one is a public leak - and it means a .env
 * that someone `git add`s by mistake is caught here rather than being invisible
 * because .gitignore lists it. (.gitignore has no effect on a file that is
 * already tracked, which is exactly how admin_dashboard/.env came to be
 * committed.)
 *
 * This complements rather than replaces .github/workflows/secret-scan.yml:
 * gitleaks scans history with a broad ruleset, this scans the current tree with
 * a few deliberately narrow ones and fails the local `npm test` immediately.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "../..");

// This file necessarily contains every pattern it searches for, so scanning it
// would always match itself. Excluded by exact resolved path - never by
// directory, glob or rule - so no other file can hide behind the exemption.
const SELF = path.resolve(__filename);

// Extensions whose contents are not text. A deny-list rather than an allow-list,
// so a credential dropped into an unanticipated file type is scanned by default
// instead of silently skipped. .svg is text and is deliberately absent.
const BINARY_EXT =
  /\.(png|jpe?g|gif|webp|ico|bmp|pdf|zip|gz|tgz|woff2?|ttf|eot|otf|mp4|mov|jks|keystore|p12|pfx)$/i;

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

function relative(file) {
  return path.relative(REPO_ROOT, file).replace(/\\/g, "/");
}

function trackedFiles() {
  let raw;
  try {
    raw = execFileSync("git", ["ls-files", "-z"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err) {
    // Fail closed. A guard that quietly scans nothing is worse than no guard,
    // because it reports green.
    throw new Error(
      `secrets guard could not enumerate tracked files via git: ${err.message}`
    );
  }

  return raw
    .split("\0")
    .filter(Boolean)
    .map((rel) => path.resolve(REPO_ROOT, rel))
    .filter((abs) => abs !== SELF && !BINARY_EXT.test(abs) && isReadableFile(abs));
}

// git tracks things that are not readable blobs: gitlinks (the .claude/worktrees
// entries are committed as mode 160000 and exist on disk as directories), and
// paths deleted in the working tree. Neither has content to scan. Symlinks are
// skipped too - the target is scanned on its own if it is tracked.
function isReadableFile(abs) {
  try {
    return fs.lstatSync(abs).isFile();
  } catch {
    return false;
  }
}

describe("SEC-015 / SEC-17.2 — no hardcoded secrets in tracked files", () => {
  const files = trackedFiles();
  const rel = files.map(relative);

  it("scans the whole tracked tree, not just src/", () => {
    expect(files.length).toBeGreaterThan(100);

    // The widening is the point of SEC-17.2. Each of these classes was
    // invisible to the previous src/**\/*.js-only walk, and each is somewhere a
    // credential can plausibly land.
    expect(rel).toContain("jest.config.js");
    expect(rel.some((f) => f.endsWith(".sql"))).toBe(true);
    expect(rel.some((f) => f.startsWith("test/"))).toBe(true);
    expect(rel.some((f) => f.startsWith("src/") && f.includes("__tests__"))).toBe(true);
    expect(rel.some((f) => f.endsWith(".json"))).toBe(true);
    expect(rel.some((f) => f.endsWith(".md"))).toBe(true);
    expect(rel.some((f) => f.endsWith(".yaml") || f.endsWith(".yml"))).toBe(true);
  });

  it("never scans a dependency tree", () => {
    // git does not track node_modules, so this holds by construction - but it
    // is the assumption the file enumeration rests on, so pin it.
    expect(rel.some((f) => f.includes("node_modules/"))).toBe(false);
  });

  it("exempts only itself, and only by exact path", () => {
    expect(files).not.toContain(SELF);
    // The exemption must not have taken its neighbours with it.
    expect(rel.some((f) => f.startsWith("test/medium/") && f !== relative(SELF))).toBe(true);
  });

  it("would catch a committed .env, which .gitignore cannot", () => {
    // backend/.env is untracked today, so this asserts the rule rather than the
    // current state: were it ever tracked, it would be in the scanned set.
    const wouldScan = (name) =>
      !BINARY_EXT.test(name) && path.resolve(REPO_ROOT, name) !== SELF;

    expect(wouldScan(".env")).toBe(true);
    expect(wouldScan(".env.production")).toBe(true);
  });

  it.each(files.map((f) => [relative(f), f]))(
    "%s contains no embedded credentials",
    (_rel, file) => {
      const content = fs.readFileSync(file, "utf8");
      const hits = SECRET_PATTERNS.filter(({ re }) => re.test(content)).map(
        ({ name }) => name
      );

      expect(hits).toEqual([]);
    }
  );
});

describe("the patterns actually match real credential shapes", () => {
  // Without this block a broken regex would make every file above pass, and the
  // suite would report green while scanning for nothing.
  //
  // Every fixture is assembled from fragments at run time. A literal
  // credential-shaped string in this file would be committed to a public
  // repository and flagged by gitleaks - correctly - so the source text must
  // never contain one, even a fake.
  const fixtures = [
    ["OpenAI-style key", "sk-" + "A1b2C3d4E5f6G7h8I9j0"],
    ["Google API key", "AIza" + "B".repeat(35)],
    ["Resend key", "re_" + "0123456789abcdef"],
    ["JWT literal", ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxIn0", "abc-_123"].join(".")],
    ["Postgres URL with password", "postgres" + "ql://user:hunter2@db.example.com:5432/app"],
    ["Supabase service_role literal", 'service' + '_role", "' + "eyJhbGciOiJIUzI1NiJ9"],
  ];

  it.each(fixtures)("detects a %s", (name, sample) => {
    const matched = SECRET_PATTERNS.filter(({ re }) => re.test(sample)).map(
      (p) => p.name
    );

    expect(matched).toContain(name);
  });

  it("does not fire on ordinary code", () => {
    const benign = [
      "const password = req.body.password;",
      "ALTER TABLE users ADD COLUMN password_hash TEXT;",
      "process.env.SUPABASE_SERVICE_ROLE_KEY",
      "postgres://localhost:5432/styliai",
      "// see https://platform.openai.com/docs",
    ].join("\n");

    const matched = SECRET_PATTERNS.filter(({ re }) => re.test(benign));

    expect(matched).toEqual([]);
  });
});
