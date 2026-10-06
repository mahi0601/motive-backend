// /api/health must say so when the database has not had this code's migrations applied, because that is
// exactly the state in which the sign-in fails with "Internal server error" while everything else looks
// fine. The check only reads, and when it cannot tell it must NOT take the app down.
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/prisma');
const migrations = require('../src/utils/migrations');

const shipped = (names) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
  for (const n of names) fs.mkdirSync(path.join(dir, n));
  fs.writeFileSync(path.join(dir, 'migration_lock.toml'), 'provider = "postgresql"'); // a file, not a migration
  return dir;
};

describe('pending migrations', () => {
  beforeEach(() => migrations._reset());
  afterAll(async () => prisma.$disconnect());

  test('none pending when the database has applied everything shipped', async () => {
    const dir = shipped(['20260101_a', '20260102_b']);
    expect(await migrations.pendingMigrations({ dir, fetchApplied: async () => new Set(['20260101_a', '20260102_b']) })).toEqual([]);
  });

  test('lists exactly the ones not applied, in order, and ignores the lock file', async () => {
    const dir = shipped(['20260103_c', '20260101_a', '20260102_b']);
    expect(await migrations.pendingMigrations({ dir, fetchApplied: async () => new Set(['20260101_a']) })).toEqual(['20260102_b', '20260103_c']);
  });

  test('extra migrations in the database (an older or newer build) are not a problem', async () => {
    const dir = shipped(['20260101_a']);
    expect(await migrations.pendingMigrations({ dir, fetchApplied: async () => new Set(['20260101_a', '20260999_from_a_newer_build']) })).toEqual([]);
  });

  test('when it cannot tell, nothing is reported: no migrations folder in the build', async () => {
    const fetchApplied = jest.fn();
    expect(await migrations.pendingMigrations({ dir: path.join(os.tmpdir(), 'does-not-exist-xyz'), fetchApplied })).toEqual([]);
    expect(fetchApplied).not.toHaveBeenCalled();
  });

  test('when it cannot tell, nothing is reported: the ledger is unreadable', async () => {
    const dir = shipped(['20260101_a']);
    expect(await migrations.pendingMigrations({ dir, fetchApplied: async () => null })).toEqual([]);
  });

  test('the answer is cached briefly, then asked again', async () => {
    const dir = shipped(['20260101_a']);
    const fetchApplied = jest.fn(async () => new Set());
    expect(await migrations.pendingMigrations({ dir, fetchApplied, now: 1000 })).toEqual(['20260101_a']);
    await migrations.pendingMigrations({ dir, fetchApplied, now: 5000 });
    expect(fetchApplied).toHaveBeenCalledTimes(1);
    await migrations.pendingMigrations({ dir, fetchApplied, now: 40000 });
    expect(fetchApplied).toHaveBeenCalledTimes(2);
  });

  test('it only reads: it never writes to the database', async () => {
    const spy = jest.spyOn(prisma, '$executeRaw');
    const rawSpy = jest.spyOn(prisma, '$executeRawUnsafe');
    await migrations.pendingMigrations({ dir: shipped(['20260101_a']) });
    expect(spy).not.toHaveBeenCalled();
    expect(rawSpy).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });

  test('against the real test database, this build\'s migrations are all applied', async () => {
    expect(await migrations.pendingMigrations()).toEqual([]);
  });
});

describe('GET /api/health', () => {
  beforeEach(() => migrations._reset());
  afterEach(() => jest.restoreAllMocks());

  test('is 200 and ok when nothing is pending', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', db: 'connected' });
    expect(res.body.pendingMigrations).toBeUndefined();
  });

  test('is 503 and says how many are pending (not their names, the endpoint is public), so the host keeps the previous version', async () => {
    const spy = jest.spyOn(migrations, 'pendingMigrations').mockResolvedValue(['20260102_b']);
    const res = await request(app).get('/api/health');
    expect(spy).toHaveBeenCalled();
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: 'migrations_pending', db: 'connected', pendingMigrations: 1 });
    expect(JSON.stringify(res.body)).not.toContain('20260102_b');
    expect(res.body.uptime).toBeUndefined();
  });

  test('a database that is down is still "degraded", not "migrations pending"', async () => {
    jest.spyOn(prisma, '$queryRaw').mockRejectedValue(new Error('down'));
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: 'degraded', db: 'disconnected' });
    expect(res.body.pendingMigrations).toBeUndefined();
  });
});
