// Integration tests need a real Postgres. Run them against a local or CI
// database — jest.setup.js refuses to run against Neon unless explicitly
// overridden (see README "Testing"). The 30s timeout leaves room for a slow
// first connection (and for ALLOW_REMOTE_TEST_DB runs) without masking a
// genuinely hung test.
module.exports = {
  testTimeout: 30000,
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/jest.setup.js'],
};
