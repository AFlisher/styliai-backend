module.exports = {
  testEnvironment: "node",
  moduleNameMapper: {
    // uuid@14 is ESM-only and Jest's CJS module system can't parse it
    // directly - see test/mocks/uuid.js for why.
    "^uuid$": "<rootDir>/test/mocks/uuid.js",
  },
};
