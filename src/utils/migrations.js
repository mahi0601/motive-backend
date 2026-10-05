// Which database migrations this code expects but the database has not had applied.
//
// Why: the app's queries name every column of the models, so running new code against a database
// that has not had its migrations applied fails on the FIRST query, and that is the login. It looks
// like "Internal server error" on the sign-in page, while /api/health used to say "ok" because it
// only checked that the database answered. /api/health now reports this too (503), so a deploy
// whose migrations were never run is refused by the host's health check and the previous version
// keeps serving, instead of replacing it with one that cannot log anyone in.
//
// It only READS: the directory of migrations shipped with the code, and Prisma's own ledger table.
// It never applies anything. When it cannot tell (no migrations folder in this build, or the ledger
// is unreadable) it says nothing is pending, so a quirk of the environment never takes the app down.
const fs = require('fs');
const path = require('path');
const prisma = require('../config/prisma');
const logger = require('../config/logger');

const DEFAULT_DIR = path.join(__dirname, '..', '..', 'prisma', 'migrations');
const CACHE_MS = 30 * 1000;

let cached = null; // { at, pending }
let warnedFor = '';

const shippedMigrations = (dir) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
    return null; // no migrations folder in this build: cannot tell
  }
};

const appliedMigrations = async () => {
  try {
    const rows = await prisma.$queryRaw`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL`;
    return new Set(rows.map((r) => r.migration_name));
  } catch {
    return null; // ledger missing or unreadable: cannot tell
  }
};

// Names of migrations shipped with this code that the database has not finished applying
// (an empty list when none, or when it cannot tell). Cached briefly: a health check runs often.
exports.pendingMigrations = async ({ dir = DEFAULT_DIR, fetchApplied = appliedMigrations, now = Date.now() } = {}) => {
  if (cached && now - cached.at < CACHE_MS && cached.dir === dir) return cached.pending;
  const shipped = shippedMigrations(dir);
  const applied = shipped ? await fetchApplied() : null;
  const pending = shipped && applied ? shipped.filter((name) => !applied.has(name)) : [];
  cached = { at: now, pending, dir };
  const key = pending.join(',');
  if (pending.length && warnedFor !== key) {
    warnedFor = key;
    logger.error('Database migrations are pending: run `npx prisma migrate deploy` against this database', { pending });
  }
  return pending;
};

exports._reset = () => {
  cached = null;
  warnedFor = '';
};
