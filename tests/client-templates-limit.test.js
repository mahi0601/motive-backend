// Saving and using a template can create hundreds of rows, so both share a tight limit.
delete process.env.CLIENT_TEMPLATE_RATE_MAX; // other files raise it; this one tests the default

const request = require('supertest');
const app = require('../src/app');
const { accessTokenFor, makeUser, cleanupUsers } = require('./helpers/fixtures');

describe('client template rate limit', () => {
  let user;
  beforeAll(async () => {
    user = await makeUser('tplLimit');
  });
  afterAll(async () => cleanupUsers(user));

  test('allows 20 saves or uses per 15 minutes from one client, then answers 429; reads are not limited', async () => {
    const auth = { Authorization: `Bearer ${await accessTokenFor(user)}` };
    const statuses = [];
    // An empty body is refused with 422 before any work, but the limiter counts it.
    for (let i = 0; i < 22; i++) statuses.push((await request(app).post('/api/client-templates').set(auth).send({})).status);
    expect(statuses.slice(0, 20).every((s) => s === 422)).toBe(true);
    expect(statuses.slice(20)).toEqual([429, 429]);
    expect((await request(app).get('/api/client-templates').set(auth)).status).toBe(200);
  });
});
