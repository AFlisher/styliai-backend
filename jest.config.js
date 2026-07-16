/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",

  // Pin the project root to THIS config file's own directory. Without this,
  // Jest's rootDir can resolve to a parent checkout when invoked through a
  // linked Git worktree, which made it discover sibling worktrees under
  // .claude/worktrees/ and inflate the suite count.
  rootDir: __dirname,

  // Only scan application source and the dedicated test tree. Sibling Git
  // worktrees live under <root>/.claude/worktrees/, which is outside both of
  // these roots, so the discovered test set is identical whether the suite is
  // run from the primary checkout or from any worktree - i.e. a deterministic
  // count in CI.
  roots: ["<rootDir>/src", "<rootDir>/test"],

  // Belt-and-suspenders: even if a test path is passed explicitly, never treat
  // vendored deps or a nested Git worktree / Claude scratch dir as a test
  // source. The .claude pattern is ANCHORED to <rootDir> on purpose: a linked
  // worktree itself lives under .claude/worktrees/, so an un-anchored
  // "/\.claude/" would match the current worktree's own path and exclude every
  // test. Anchored, it only ignores .claude dirs NESTED below this root.
  // (Overriding this option replaces Jest's default, so node_modules is listed
  // here too.)
  testPathIgnorePatterns: [
    "/node_modules/",
    "<rootDir>/\\.claude/",
  ],

  moduleNameMapper: {
    // uuid@14 is ESM-only and Jest's CJS module system can't parse it
    // directly - see test/mocks/uuid.js for why.
    "^uuid$": "<rootDir>/test/mocks/uuid.js",
  },
};
