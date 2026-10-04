// Each copy can create hundreds of rows, so it has its own tight limit per client.
delete process.env.DUPLICATE_RATE_MAX; // other files raise it; this one tests the default

const request = require('supertest');
const app = require('../src/app');
const { accessTokenFor, makeUser, makeWorkspaceWithMembers, cleanupUsers } = require('./helpers/fixtures');

describe('duplicate rate limit', () => {
  let user, ws;
  beforeAll(async () => {
    user = await makeUser('dupLimit');
    ws = await makeWorkspaceWithMembers(user);
  });
  afterAll(async () => cleanupUsers(user));

  test('allows 10 per 15 minutes from one client, then answers 429', async () => {
    const auth = { Authorization: `Bearer ${await accessTokenFor(user)}` };
    const statuses = [];
    // An empty body is refused with 422 before any work, but the limiter counts it.
    for (let i = 0; i < 12; i++) statuses.push((await request(app).post(`/api/workspaces/${ws.id}/duplicate`).set(auth).send({})).status);
    expect(statuses.slice(0, 10).every((s) => s === 422)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });
});
