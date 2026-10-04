// Refuses to run the suite against a hosted (Neon) database. These tests create
// and delete real rows, and until now `npm test` silently used whatever
// DATABASE_URL .env pointed at — which for local development is the real dev
// database. Point DATABASE_URL at a local/throwaway Postgres instead (CI does).
// Set ALLOW_REMOTE_TEST_DB=1 only if you deliberately want to run against a
// hosted database you are prepared to have test rows written to.
// .env is loaded here, before the check: the app loads it later (config/env.js), so without this
// the check below sees an empty DATABASE_URL and passes while the app goes on to use the hosted
// database from .env. dotenv never overrides a variable that is already set, so a local
// DATABASE_URL given on the command line still wins.
require('dotenv').config({ quiet: true });
const url = process.env.DATABASE_URL || '';
if (/neon\.tech/i.test(url) && process.env.ALLOW_REMOTE_TEST_DB !== '1') {
  throw new Error(
    'Refusing to run tests against a Neon database. Set DATABASE_URL to a local or throwaway ' +
      'Postgres, or set ALLOW_REMOTE_TEST_DB=1 to override. See README "Testing".'
  );
}

// Keep test output readable — pino-http logs every request otherwise. Set
// LOG_LEVEL explicitly (e.g. LOG_LEVEL=debug npm test) to see logs when
// debugging a failure.
if (!process.env.LOG_LEVEL) process.env.LOG_LEVEL = 'silent';
