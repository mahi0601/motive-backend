// Each import can create up to 500 tasks, so it has its own tight limit per client.
delete process.env.IMPORT_RATE_MAX; // other files raise it; this one tests the default

const request = require('supertest');
const app = require('../src/app');
const { accessTokenFor, makeUser, cleanupUsers } = require('./helpers/fixtures');

describe('import rate limit', () => {
  let user;
  beforeAll(async () => {
    user = await makeUser('impLimit');
  });
  afterAll(async () => {
    await cleanupUsers(user);
  });

  test('allows 10 imports per 15 minutes from one client, then answers 429', async () => {
    const auth = { Authorization: `Bearer ${await accessTokenFor(user)}` };
    // An empty list is refused with 422 before any work, but the limiter counts it.
    const statuses = [];
    for (let i = 0; i < 12; i++) statuses.push((await request(app).post('/api/tasks/import').set(auth).send({ tasks: [] })).status);
    expect(statuses.slice(0, 10).every((s) => s === 422)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });
});
