// Honest numbers. The funnel's "link opened" step is the one that says a real
// client looked, so it must not be inflated by the owner previewing their own
// link, and the growth loop (the footer on a free status page) needs a way to be
// counted. Both stay first-party, ids and a daily-rotating hash only.
const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/prisma');
const analytics = require('../src/services/analytics.service');
const { accessTokenFor, makeUser, makeWorkspaceWithMembers, cleanupUsers } = require('./helpers/fixtures');

const events = (where) => prisma.productEvent.findMany({ where });

// A view is recorded fire-and-forget (it must never slow the page), so the row
// lands slightly after the response. Wait for it instead of guessing; for "nothing
// was recorded" give any in-flight write time to land first.
const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));
const waitForCount = async (where, expected, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  let n;
  do {
    n = await prisma.productEvent.count({ where });
    if (n === expected) return n;
    await settle(50);
  } while (Date.now() < deadline);
  return n;
};

describe('owner previews are not counted as views', () => {
  let owner, ws, token;
  beforeAll(async () => {
    owner = await makeUser('metricsOwner');
    ws = await makeWorkspaceWithMembers(owner);
    const auth = { Authorization: `Bearer ${await accessTokenFor(owner)}` };
    token = (await request(app).post(`/api/workspaces/${ws.id}/share`).set(auth)).body.share.token;
  });
  afterAll(async () => {
    await prisma.productEvent.deleteMany({ where: { workspaceId: ws.id } });
    await cleanupUsers(owner);
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await settle(); // let the previous test's fire-and-forget write land before clearing
    await prisma.productEvent.deleteMany({ where: { workspaceId: ws.id, name: 'status_page_viewed' } });
  });

  test('a normal view is counted', async () => {
    expect((await request(app).get(`/api/status/${token}`)).status).toBe(200);
    expect(await waitForCount({ workspaceId: ws.id, name: 'status_page_viewed' }, 1)).toBe(1);
  });

  test('a view marked as a preview returns the same page but records nothing', async () => {
    const normal = await request(app).get(`/api/status/${token}`);
    await waitForCount({ workspaceId: ws.id, name: 'status_page_viewed' }, 1);
    await prisma.productEvent.deleteMany({ where: { workspaceId: ws.id, name: 'status_page_viewed' } });
    const preview = await request(app).get(`/api/status/${token}?preview=1`);
    expect(preview.status).toBe(200);
    expect(preview.body).toEqual(normal.body);
    await settle();
    expect(await events({ workspaceId: ws.id, name: 'status_page_viewed' })).toHaveLength(0);
  });

  test('only preview=1 counts as a preview; other values are ordinary views', async () => {
    for (const v of ['0', 'true', '', 'yes']) await request(app).get(`/api/status/${token}?preview=${v}`);
    expect(await waitForCount({ workspaceId: ws.id, name: 'status_page_viewed' }, 4)).toBe(4);
  });

  test('a preview of an unknown link is still the same 404', async () => {
    expect((await request(app).get(`/api/status/${'0'.repeat(64)}?preview=1`)).status).toBe(404);
  });
});

describe('landing visits from a status page', () => {
  const landing = () => request(app).post('/api/status/landing').set('User-Agent', 'LandingBrowser');
  const count = () => prisma.productEvent.count({ where: { name: 'landing_from_status' } });
  afterAll(async () => {
    await prisma.productEvent.deleteMany({ where: { name: 'landing_from_status' } });
  });

  test('is an allowed event, so it is stored', async () => {
    const before = await count();
    expect((await landing()).status).toBe(204);
    expect(await count()).toBe(before + 1);
  });

  test('stores only a name and the daily visitor hash: no ids, ip or user agent', async () => {
    await prisma.productEvent.deleteMany({ where: { name: 'landing_from_status' } });
    await landing().send({ userId: 'someone', workspaceId: 'ws', email: 'a@b.c' });
    const [row] = await prisma.productEvent.findMany({ where: { name: 'landing_from_status' } });
    expect(row.userId).toBeNull();
    expect(row.workspaceId).toBeNull();
    expect(row.visitor).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(row)).not.toMatch(/LandingBrowser|127\.0\.0\.1|::1|someone|a@b\.c/);
  });

  test('the endpoint is rate limited per client, because it is an unauthenticated write', async () => {
    const statuses = [];
    for (let i = 0; i < 40; i++) statuses.push((await landing()).status);
    expect(statuses).toContain(429);
    expect(statuses[0]).toBe(204);
  });
});

describe('weekly active client pages', () => {
  const tag = `wk${Date.now()}`;
  const day = 86400000;
  afterAll(async () => {
    await prisma.productEvent.deleteMany({ where: { OR: [{ workspaceId: { startsWith: tag } }, { visitor: { startsWith: 'zz' } }] } });
    await prisma.$disconnect();
  });

  test('counts pages viewed in the last 7 days, whatever the funnel window, and each page once', async () => {
    const now = Date.now();
    await prisma.productEvent.createMany({
      data: [
        { name: 'status_page_viewed', workspaceId: `${tag}-recent`, visitor: 'zz00000000000001', createdAt: new Date(now - 2 * day) },
        { name: 'status_page_viewed', workspaceId: `${tag}-recent`, visitor: 'zz00000000000002', createdAt: new Date(now - 1 * day) },
        { name: 'status_page_viewed', workspaceId: `${tag}-stale`, visitor: 'zz00000000000003', createdAt: new Date(now - 10 * day) },
        { name: 'feedback_received', workspaceId: `${tag}-recent`, createdAt: new Date(now - 1 * day) },
      ],
    });
    const f = await analytics.funnel({ since: new Date(now - 30 * day), scope: tag });
    expect(f.activePages7d).toBe(1);
    expect(f.linksViewed).toBe(2); // both pages were opened within 30 days
    const short = await analytics.funnel({ since: new Date(now - 3 * day), scope: tag });
    expect(short.activePages7d).toBe(1); // independent of the funnel window
  });

  test('the report shows the new numbers and still has no NaN', () => {
    const base = { signups: 0, activated: 0, linksCreated: 0, linksViewed: 0, viewers: 0, feedbackReceived: 0, upgraded: 0, activePages7d: 0, landingVisitors: 0 };
    const text = analytics.formatFunnel({ ...base, activePages7d: 4, landingVisitors: 9 }, 30);
    expect(text).toMatch(/Active client pages, last 7 days\s+4/);
    expect(text).toMatch(/Visitors from a status page footer\s+9/);
    expect(text).not.toMatch(/includes the owner previewing/i);
    expect(analytics.formatFunnel(base, 7)).not.toMatch(/NaN|Infinity/);
  });
});
