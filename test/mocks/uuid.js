// uuid@14 is ESM-only; Node's require(esm) interop handles that fine at
// runtime, but Jest's CJS module system can't parse it yet. This CJS shim
// stands in for it in tests project-wide (see jest.config.js
// moduleNameMapper) - crypto.randomUUID() is a real Node builtin, so this
// still produces genuine, valid v4 UUIDs.
const crypto = require("crypto");

module.exports = {
  v4: () => crypto.randomUUID(),
};
