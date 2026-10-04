// Its own file so the route's rate limiter starts empty (limiter state lives in
// the app module, which Jest isolates per test file).
const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/prisma');
const { accessTokenFor, makeUser, makeWorkspaceWithMembers, cleanupUsers } = require('./helpers/fixtures');

test('the public request route is limited to 10 posts per 15 minutes per client', async () => {
  const owner = await makeUser('rqRateOwner');
  try {
    const ws = await makeWorkspaceWithMembers(owner);
    const auth = { Authorization: `Bearer ${await accessTokenFor(owner)}` };
    await request(app).patch(`/api/workspaces/${ws.id}/status-page`).set(auth).send({ allowRequests: true });
    const { token } = (await request(app).post(`/api/workspaces/${ws.id}/share`).set(auth)).body.share;

    const codes = [];
    for (let i = 0; i < 12; i += 1) {
      codes.push((await request(app).post(`/api/status/${token}/requests`).send({ name: 'Ann', title: `r${i}` })).status);
    }
    expect(codes.slice(0, 10)).toEqual(Array(10).fill(201));
    expect(codes.slice(10)).toEqual([429, 429]);
  } finally {
    await cleanupUsers(owner);
    await prisma.$disconnect();
  }
});
