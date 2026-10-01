// First-party product analytics: a handful of server-side events that answer
// "is anyone getting to the point of the product?". No tracking script, no
// cookies, no third party. Events hold ids and a name only: never an email, a
// task title, a token or an IP address. The only thing derived from a visitor is
// a daily-rotating hash that can count unique viewers and cannot be reversed or
// linked across days.
const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/prisma');
const analytics = require('../src/services/analytics.service');
const authService = require('../src/services/auth.service');
const taskService = require('../src/services/task.service');
const { runCleanup } = require('../src/jobs/cleanup');
const { accessTokenFor, makeUser, makeWorkspaceWithMembers, cleanupUsers, testEmail } = require('./helpers/fixtures');

const events = (where) => prisma.productEvent.findMany({ where, orderBy: { createdAt: 'asc' } });

describe('analytics.track', () => {
  const marker = `m${Date.now()}`;
  afterAll(async () => {
    await prisma.productEvent.deleteMany({ where: { userId: { startsWith: marker } } });
    await prisma.$disconnect();
  });

  test('stores an allowed event with only ids', async () => {
    await analytics.track('signup', { userId: `${marker}-u1`, workspaceId: `${marker}-w1` });
    const [row] = await events({ userId: `${marker}-u1` });
    expect(row).toMatchObject({ name: 'signup', workspaceId: `${marker}-w1` });
    expect(Object.keys(row).sort()).toEqual(['createdAt', 'id', 'name', 'userId', 'visitor', 'workspaceId']);
  });

  test('ignores a name that is not in the allowlist, so a typo cannot create junk', async () => {
    await analytics.track('totally_made_up', { userId: `${marker}-u2` });
    expect(await events({ userId: `${marker}-u2` })).toHaveLength(0);
  });

  test('never throws, even when the write fails', async () => {
    const spy = jest.spyOn(prisma.productEvent, 'create').mockRejectedValueOnce(new Error('db down'));
    await expect(analytics.track('signup', { userId: `${marker}-u3` })).resolves.toBeUndefined();
    spy.mockRestore();
  });
});

describe('visitorKey', () => {
  test('is stable for the same visitor on the same day and different otherwise', () => {
    const day = new Date('2026-10-02T10:00:00Z');
    const a = analytics.visitorKey({ ip: '203.0.113.5', userAgent: 'UA', now: day });
    expect(a).toBe(analytics.visitorKey({ ip: '203.0.113.99', userAgent: 'UA', now: day })); // same /24
    expect(a).not.toBe(analytics.visitorKey({ ip: '198.51.100.5', userAgent: 'UA', now: day }));
    expect(a).not.toBe(analytics.visitorKey({ ip: '203.0.113.5', userAgent: 'Other', now: day }));
    expect(a).not.toBe(analytics.visitorKey({ ip: '203.0.113.5', userAgent: 'UA', now: new Date('2026-10-03T10:00:00Z') }));
  });

  test('contains neither the ip nor the user agent', () => {
    const key = analytics.visitorKey({ ip: '203.0.113.5', userAgent: 'SecretAgent/1.0', now: new Date() });
    expect(key).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('events written by real flows', () => {
  const users = [];
  afterEach(async () => {
    await cleanupUsers(...users.splice(0));
  });

  test('signing up records one signup, and signing in does not', async () => {
    const email = testEmail('anSignup');
    const { user } = await authService.register({ name: 'A', email, password: 'correct-horse-1' });
    users.push(user);
    await authService.login({ email, password: 'correct-horse-1' });
    expect(await events({ name: 'signup', userId: user.id })).toHaveLength(1);
  });

  test('first_task_created is recorded for the first task only', async () => {
    const user = await makeUser('anTask');
    users.push(user);
    await taskService.create({ title: 'one' }, user.id);
    await taskService.create({ title: 'two' }, user.id);
    expect(await events({ name: 'first_task_created', userId: user.id })).toHaveLength(1);
  });

  test('creating a status link, a status view and a client response are recorded', async () => {
    const owner = await makeUser('anLink');
    users.push(owner);
    const ws = await makeWorkspaceWithMembers(owner);
    const auth = { Authorization: `Bearer ${await accessTokenFor(owner)}` };
    await request(app).patch(`/api/workspaces/${ws.id}/status-page`).set(auth).send({ allowFeedback: true });
    const { token } = (await request(app).post(`/api/workspaces/${ws.id}/share`).set(auth)).body.share;
    await request(app).get(`/api/status/${token}`).set('User-Agent', 'TestBrowser');
    await request(app).post(`/api/status/${token}/feedback`).send({ kind: 'comment', name: 'Ann', message: 'hi' });

    expect(await events({ name: 'status_link_created', workspaceId: ws.id })).toHaveLength(1);
    const views = await events({ name: 'status_page_viewed', workspaceId: ws.id });
    expect(views).toHaveLength(1);
    expect(views[0].visitor).toMatch(/^[0-9a-f]{16}$/);
    expect(await events({ name: 'feedback_received', workspaceId: ws.id })).toHaveLength(1);
    expect(JSON.stringify(await events({ workspaceId: ws.id }))).not.toMatch(/TestBrowser|127\.0\.0\.1|::1|Ann/);
  });

  test('a view of an unknown link records nothing', async () => {
    const before = await prisma.productEvent.count({ where: { name: 'status_page_viewed' } });
    await request(app).get(`/api/status/${'0'.repeat(64)}`);
    expect(await prisma.productEvent.count({ where: { name: 'status_page_viewed' } })).toBe(before);
  });
});

describe('funnel', () => {
  const tag = `fn${Date.now()}`;
  const day = 86400000;
  afterAll(async () => {
    await prisma.productEvent.deleteMany({ where: { OR: [{ userId: { startsWith: tag } }, { workspaceId: { startsWith: tag } }] } });
    await prisma.$disconnect();
  });

  test('counts distinct people and workspaces per stage, within the window only', async () => {
    const now = new Date();
    const old = new Date(now.getTime() - 40 * day);
    const rows = [
      ['signup', 'u1'], ['signup', 'u2'], ['signup', 'u3'],
      ['first_task_created', 'u1'], ['first_task_created', 'u2'],
      ['upgraded', 'u1'],
    ].map(([name, u]) => ({ name, userId: `${tag}-${u}` }));
    rows.push(
      { name: 'status_link_created', workspaceId: `${tag}-w1` },
      { name: 'status_link_created', workspaceId: `${tag}-w1` }, // replaced link: still one workspace
      { name: 'status_page_viewed', workspaceId: `${tag}-w1`, visitor: 'aaaaaaaaaaaaaaaa' },
      { name: 'status_page_viewed', workspaceId: `${tag}-w1`, visitor: 'aaaaaaaaaaaaaaaa' }, // same visitor
      { name: 'status_page_viewed', workspaceId: `${tag}-w1`, visitor: 'bbbbbbbbbbbbbbbb' },
      { name: 'feedback_received', workspaceId: `${tag}-w1` },
      { name: 'signup', userId: `${tag}-old`, createdAt: old },
    );
    await prisma.productEvent.createMany({ data: rows });

    const since = new Date(now.getTime() - 30 * day);
    const f = await analytics.funnel({ since, scope: tag });
    expect(f).toMatchObject({ signups: 3, activated: 2, upgraded: 1, linksCreated: 1, linksViewed: 1, viewers: 2, feedbackReceived: 1 });
  });

  test('formats a readable report with conversion percentages and no divide-by-zero', () => {
    const text = analytics.formatFunnel({ signups: 10, activated: 5, linksCreated: 2, linksViewed: 1, viewers: 3, feedbackReceived: 0, upgraded: 0 }, 30);
    expect(text).toMatch(/last 30 days/i);
    expect(text).toMatch(/Signed up\s+10/);
    expect(text).toMatch(/Added a first task\s+5\s+\(50%\)/);
    expect(analytics.formatFunnel({ signups: 0, activated: 0, linksCreated: 0, linksViewed: 0, viewers: 0, feedbackReceived: 0, upgraded: 0 }, 7)).not.toMatch(/NaN|Infinity/);
  });

  test('upgrades are recorded when a plan change turns Pro on, not when it turns off', async () => {
    const user = await makeUser('anUpgrade');
    try {
      const payment = require('../src/services/payment.service');
      await prisma.user.update({ where: { id: user.id }, data: { stripeSubscriptionId: `sub_${tag}` } });
      await payment.handleWebhookEvent({ id: `evt_${tag}_1`, type: 'customer.subscription.created', data: { object: { id: `sub_${tag}`, status: 'active', metadata: { userId: user.id } } } });
      await payment.handleWebhookEvent({ id: `evt_${tag}_2`, type: 'customer.subscription.deleted', data: { object: { id: `sub_${tag}`, status: 'canceled', metadata: { userId: user.id } } } });
      expect(await events({ name: 'upgraded', userId: user.id })).toHaveLength(1);
    } finally {
      await prisma.webhookEvent.deleteMany({ where: { stripeEventId: { startsWith: `evt_${tag}` } } });
      await cleanupUsers(user);
    }
  });
});

describe('retention', () => {
  test('product events older than 400 days are pruned, newer ones kept', async () => {
    const tag = `rt${Date.now()}`;
    await prisma.productEvent.createMany({
      data: [
        { name: 'signup', userId: `${tag}-old`, createdAt: new Date(Date.now() - 401 * 86400000) },
        { name: 'signup', userId: `${tag}-new`, createdAt: new Date(Date.now() - 100 * 86400000) },
      ],
    });
    await runCleanup();
    expect(await prisma.productEvent.count({ where: { userId: `${tag}-old` } })).toBe(0);
    expect(await prisma.productEvent.count({ where: { userId: `${tag}-new` } })).toBe(1);
    await prisma.productEvent.deleteMany({ where: { userId: `${tag}-new` } });
  });
});
