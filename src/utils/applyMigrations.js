// Applies pending database migrations before the server starts (production only).
//
// Why: the host's build command is a dashboard setting that can override render.yaml, and when it
// lacks `prisma migrate deploy` the new code boots against an old schema and sign-in fails with a
// 500. Running it here makes every deploy self-contained. It goes through Neon's direct host,
// because the "-pooler" (PgBouncer) one cannot hold the advisory lock `migrate deploy` takes.
// A failure exits non-zero, so the host's health check refuses the deploy and the previous
// version keeps serving. Set RUN_MIGRATIONS=false to skip it.
const { spawnSync } = require('child_process');

module.exports = function applyMigrations() {
  if (process.env.NODE_ENV !== 'production' || process.env.RUN_MIGRATIONS === 'false') return;
  const url = process.env.DATABASE_URL;
  if (!url) return;
  const res = spawnSync('npx', ['prisma', 'migrate', 'deploy'], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url.replace('-pooler', '') },
  });
  if (res.status !== 0) {
    console.error('prisma migrate deploy failed; refusing to start against an unmigrated database.');
    process.exit(1);
  }
};
