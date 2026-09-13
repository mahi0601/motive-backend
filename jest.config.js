// Integration tests run against the real (dev) Neon Postgres — there's no
// separate test DB configured (see README). Neon's pooled connection has a
// real cold-start latency on the first query of a run, which blows past
// Jest's 5s default hook timeout with no actual bug involved — 30s gives
// that room without masking a genuinely hung test.
module.exports = {
  testTimeout: 30000,
  testEnvironment: 'node',
};
