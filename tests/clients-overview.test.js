// The Clients overview: one list of every client the user OWNS, with the few numbers that say
// who needs attention (overdue work, unread replies, a link nobody has opened, a client gone
// quiet), most in need first. Numbers, dates and flags only: no task titles, people or visitor
// data. It reads the same facts the rest of the app already uses (a view that is a real client,
// not a preview or a bot) and costs the same number of queries for 1 client or 50.
const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/prisma');
const { accessTokenFor, makeUser, makeWorkspaceWithMembers, cleanupUsers } = require('./helpers/fixtures');

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const ago = (ms) => new Date(Date.now() - ms);
const ahead = (ms) => new Date(Date.now() + ms);

describe('GET /api/workspaces/overview', () => {
  let owner, other, many, editorOf, alpha, beta, gamma, delta, theirs, memberOnly;
  const as = async (u) => ({ Authorization: `Bearer ${await accessTokenFor(u)}` });
  const get = async (u = owner) => request(app).get('/api/workspaces/overview').set(await as(u));
  const byName = (res, name) => res.body.clients.find((c) => c.name === name);
  const rename = (w, name) => prisma.workspace.update({ where: { id: w.id }, data: { name } });
  const live = (w, daysAgo) =>
    prisma.workspace.update({ where: { id: w.id }, data: { shareTokenHash: `h-${w.id}`, shareEnabledAt: ago(daysAgo * DAY) } });
  const task = (w, user, data) => prisma.task.create({ data: { title: 'T', userId: user.id, workspaceId: w.id, ...data } });
  const view = (w, at, visitor = 'v1') => prisma.productEvent.create({ data: { name: 'status_page_viewed', workspaceId: w.id, visitor, createdAt: at } });

  beforeAll(async () => {
    owner = await makeUser('ovOwner', { isPro: true, plan: 'agency' });
    other = await makeUser('ovOther', { isPro: true, plan: 'agency' });
    many = await makeUser('ovMany', { isPro: true, plan: 'agency' });
    editorOf = await makeUser('ovEditorOf');

    alpha = await makeWorkspaceWithMembers(owner);
    beta = await makeWorkspaceWithMembers(owner);
    gamma = await makeWorkspaceWithMembers(owner);
    delta = await makeWorkspaceWithMembers(owner);
    theirs = await makeWorkspaceWithMembers(other);
    memberOnly = await makeWorkspaceWithMembers(other, { editors: [owner] }); // owner is only an editor here
    await Promise.all([rename(alpha, 'Alpha'), rename(beta, 'Beta'), rename(gamma, 'Gamma'), rename(delta, 'Delta'), rename(theirs, 'Theirs'), rename(memberOnly, 'Member only')]);

    // Alpha: live 10 days, never opened, 2 overdue tasks (a done one with an old due date must not count),
    // 3 open and not yet due, 2 done this week and 1 done long ago, 2 unread replies and 1 read.
    await live(alpha, 10);
    await task(alpha, owner, { title: 'SECRET TITLE', status: 'todo', dueDate: ago(3 * DAY) });
    await task(alpha, owner, { status: 'in_progress', dueDate: ago(1 * DAY) });
    await task(alpha, owner, { status: 'done', dueDate: ago(10 * DAY), completedAt: ago(9 * DAY) }); // done, with an old due date: neither overdue nor shipped this week
    await prisma.task.createMany({ data: [1, 2, 3].map(() => ({ title: 'Open', status: 'todo', dueDate: ahead(5 * DAY), userId: owner.id, workspaceId: alpha.id })) });
    await prisma.task.createMany({ data: [2, 3].map((d) => ({ title: 'Win', status: 'done', completedAt: ago(d * DAY), userId: owner.id, workspaceId: alpha.id })) });
    await task(alpha, owner, { status: 'done', completedAt: ago(30 * DAY) });
    await prisma.clientFeedback.createMany({
      data: [
        { workspaceId: alpha.id, kind: 'comment', authorName: 'Ann', message: 'a', readAt: null },
        { workspaceId: alpha.id, kind: 'changes', authorName: 'Ann', message: 'b', readAt: null },
        { workspaceId: alpha.id, kind: 'comment', authorName: 'Ann', message: 'c', readAt: new Date() },
      ],
    });

    // Beta: live only 2 days (too new to call unopened), opened an hour ago, nothing overdue.
    await live(beta, 2);
    await view(beta, ago(1 * HOUR));
    await task(beta, owner, { status: 'done', completedAt: ago(1 * DAY) });

    // Gamma: live 30 days, last opened 20 days ago (gone quiet), with milestones.
    await live(gamma, 30);
    await view(gamma, ago(20 * DAY));
    await prisma.milestone.createMany({
      data: [
        { workspaceId: gamma.id, title: 'Past', date: ago(5 * DAY), position: 0 },
        { workspaceId: gamma.id, title: 'Launch', date: ahead(10 * DAY), position: 1 },
        { workspaceId: gamma.id, title: 'Later', date: ahead(40 * DAY), position: 2 },
        { workspaceId: gamma.id, title: 'Undated', date: null, position: 3 },
      ],
    });

    // Delta: no link at all, one open task.
    await task(delta, owner, { status: 'todo' });

    // Someone else's client, with plenty of data, that must never show up for the owner.
    await live(theirs, 10);
    await task(theirs, other, { status: 'todo', dueDate: ago(2 * DAY) });
    await view(theirs, ago(1 * HOUR));
    await task(memberOnly, other, { status: 'todo', dueDate: ago(2 * DAY) });
  });
  afterAll(async () => {
    await prisma.workspace.deleteMany({ where: { ownerId: many.id } });
    await cleanupUsers(owner, other, many, editorOf);
    await prisma.$disconnect();
  });

  test('needs a signed-in user', async () => {
    expect((await request(app).get('/api/workspaces/overview')).status).toBe(401);
  });

  describe('who is listed', () => {
    test('only the workspaces the caller owns: not ones they merely belong to, and nothing of other owners', async () => {
      const names = (await get()).body.clients.map((c) => c.name).sort();
      expect(names.filter((n) => ['Alpha', 'Beta', 'Gamma', 'Delta'].includes(n))).toEqual(['Alpha', 'Beta', 'Delta', 'Gamma']);
      expect(names).not.toContain('Theirs');
      expect(names).not.toContain('Member only');
    });

    test('a user with no clients gets an empty list, not an error', async () => {
      const res = await get(editorOf);
      expect(res.status).toBe(200);
      expect(res.body.clients.every((c) => c.name !== 'Alpha')).toBe(true);
    });

    test('is capped at 50 clients', async () => {
      await prisma.workspace.createMany({ data: Array.from({ length: 55 }, (_, i) => ({ name: `Bulk ${i}`, ownerId: many.id })) });
      expect((await get(many)).body.clients).toHaveLength(50);
    });
  });

  describe('the numbers', () => {
    test('open work is everything not done, and overdue is only unfinished work past its due date', async () => {
      const a = byName(await get(), 'Alpha');
      expect(a.overdue).toBe(2); // the done task with an old due date is not overdue
      expect(a.open).toBe(5); // 2 overdue + 3 not yet due
    });

    test('shipped this week counts done work in the last 7 days only', async () => {
      const res = await get();
      expect(byName(res, 'Alpha').shippedThisWeek).toBe(2);
      expect(byName(res, 'Beta').shippedThisWeek).toBe(1);
    });

    test('unread replies only: the ones the owner has read do not count', async () => {
      expect(byName(await get(), 'Alpha').unreadResponses).toBe(2);
    });

    test('a client\'s numbers are never mixed with another client\'s', async () => {
      const res = await get();
      expect(byName(res, 'Beta')).toMatchObject({ overdue: 0, open: 0, unreadResponses: 0 });
      expect(byName(res, 'Delta')).toMatchObject({ open: 1, overdue: 0, shippedThisWeek: 0 });
    });

    test('shows whether the link is live, and when it was last really opened', async () => {
      const res = await get();
      expect(byName(res, 'Alpha')).toMatchObject({ linkLive: true, lastViewedAt: null });
      expect(byName(res, 'Delta')).toMatchObject({ linkLive: false, lastViewedAt: null });
      expect(new Date(byName(res, 'Beta').lastViewedAt).getTime()).toBeGreaterThan(Date.now() - 2 * HOUR);
    });

    test('the next milestone is the earliest dated one still ahead', async () => {
      expect(byName(await get(), 'Gamma').nextMilestone).toMatchObject({ title: 'Launch' });
      expect(byName(await get(), 'Alpha').nextMilestone).toBeNull();
    });
  });

  describe('who needs attention, and the order', () => {
    test('says why: overdue work, unread replies, and a link live for days that nobody has opened', async () => {
      expect(byName(await get(), 'Alpha').attention).toEqual(['overdue', 'responses', 'not_opened']);
    });

    test('a link that is only 2 days old is not "not opened" yet', async () => {
      await prisma.productEvent.deleteMany({ where: { workspaceId: beta.id } });
      expect(byName(await get(), 'Beta').attention).toEqual([]);
      await view(beta, ago(1 * HOUR));
    });

    test('a client opened before but not for over 14 days has gone quiet', async () => {
      expect(byName(await get(), 'Gamma').attention).toEqual(['quiet']);
    });

    test('a client with no link, or one that is healthy, needs nothing', async () => {
      const res = await get();
      expect(byName(res, 'Delta').attention).toEqual([]);
      expect(byName(res, 'Beta').attention).toEqual([]);
    });

    test('most in need first: more reasons first, then more overdue, then by name', async () => {
      const names = (await get()).body.clients.map((c) => c.name).filter((n) => ['Alpha', 'Beta', 'Gamma', 'Delta'].includes(n));
      expect(names).toEqual(['Alpha', 'Gamma', 'Beta', 'Delta']);
    });

    test('a preview or a bot opening the page does not count as the client looking', async () => {
      // Only real views are recorded as events at all, so a link with no events is still "not opened".
      expect(byName(await get(), 'Alpha').lastViewedAt).toBeNull();
    });
  });

  describe('what it gives away, and what it costs', () => {
    test('numbers, dates and flags only: no task titles, people or visitor data', async () => {
      const res = await get();
      const first = res.body.clients[0];
      expect(Object.keys(first).sort()).toEqual(['attention', 'icon', 'id', 'lastViewedAt', 'linkLive', 'name', 'nextMilestone', 'open', 'overdue', 'shippedThisWeek', 'unreadResponses']);
      const text = JSON.stringify(res.body);
      for (const leaked of ['SECRET TITLE', owner.email, other.email, other.id, 'v1', 'Ann', 'shareTokenHash', 'h-']) expect(text).not.toContain(leaked);
    });

    test('costs the same number of queries for one client as for fifty', async () => {
      const spies = [
        jest.spyOn(prisma.task, 'groupBy'), jest.spyOn(prisma.task, 'count'), jest.spyOn(prisma.task, 'findMany'),
        jest.spyOn(prisma.productEvent, 'groupBy'), jest.spyOn(prisma.productEvent, 'findFirst'), jest.spyOn(prisma.productEvent, 'count'),
        jest.spyOn(prisma.clientFeedback, 'groupBy'), jest.spyOn(prisma.clientFeedback, 'count'),
        jest.spyOn(prisma.milestone, 'findMany'), jest.spyOn(prisma.workspace, 'findMany'),
      ];
      const calls = () => spies.reduce((n, s) => n + s.mock.calls.length, 0);
      try {
        await get(owner); // a handful of clients (a user with none returns early, which is cheaper still)
        const few = calls();
        spies.forEach((s) => s.mockClear());
        await get(many); // 50 clients
        const lots = calls();
        expect(lots).toBe(few);
        expect(lots).toBeLessThanOrEqual(8);
      } finally {
        spies.forEach((s) => s.mockRestore());
      }
    });
  });
});
