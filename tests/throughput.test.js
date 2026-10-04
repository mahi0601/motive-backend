// "Shipped each week" on the public status page: how many tasks were finished in each of the
// last 8 weeks (Monday to Sunday, UTC), so a client can see momentum, not just a total. Counts
// only: no titles. Exact however many tasks the project has, because it is counted in the
// database rather than from the page's capped task list.
const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/prisma');
const { accessTokenFor, makeUser, makeWorkspaceWithMembers, cleanupUsers } = require('./helpers/fixtures');

const DAY = 24 * 60 * 60 * 1000;
// Monday 00:00 UTC of the week containing `d`.
const mondayOf = (d) => {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  return new Date(x.getTime() - ((x.getUTCDay() + 6) % 7) * DAY);
};
const ymd = (d) => d.toISOString().slice(0, 10);

describe('shipped each week on the public status page', () => {
  let owner, other, ws, otherWs, token;
  const as = async (u) => ({ Authorization: `Bearer ${await accessTokenFor(u)}` });
  const throughput = async (t = token) => (await request(app).get(`/api/status/${t}`)).body.status.throughput;
  const done = (workspace, user, completedAt, extra = {}) =>
    prisma.task.create({ data: { title: 'T', status: 'done', completedAt, userId: user.id, workspaceId: workspace.id, ...extra } });
  const thisMonday = () => mondayOf(new Date());
  const weekAgo = (n) => new Date(thisMonday().getTime() - n * 7 * DAY);

  beforeAll(async () => {
    owner = await makeUser('tpOwner', { isPro: true });
    other = await makeUser('tpOther', { isPro: true });
    ws = await makeWorkspaceWithMembers(owner);
    otherWs = await makeWorkspaceWithMembers(other);
    token = (await request(app).post(`/api/workspaces/${ws.id}/share`).set(await as(owner))).body.share.token;
    await prisma.workspace.update({ where: { id: ws.id }, data: { name: 'Acme Redesign' } });
  });
  beforeEach(async () => {
    await prisma.task.deleteMany({ where: { workspaceId: { in: [ws.id, otherWs.id] } } });
  });
  afterAll(async () => {
    await cleanupUsers(owner, other);
    await prisma.$disconnect();
  });

  test('is 8 weeks, oldest first, each starting on a Monday, the last being this week', async () => {
    const t = await throughput();
    expect(t.items).toHaveLength(8);
    expect(t.weeks).toBe(8);
    expect(t.items.every((w) => new Date(`${w.start}T00:00:00Z`).getUTCDay() === 1)).toBe(true);
    expect(t.items[7].start).toBe(ymd(thisMonday()));
    expect(t.items[0].start).toBe(ymd(weekAgo(7)));
    for (let i = 1; i < 8; i++) expect(new Date(t.items[i].start) - new Date(t.items[i - 1].start)).toBe(7 * DAY);
  });

  test('an empty project is eight weeks of zero, not missing weeks', async () => {
    expect((await throughput()).items.map((w) => w.count)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  test('counts each done task in the week it was completed', async () => {
    const mid = (w) => new Date(w.getTime() + 2 * DAY + 12 * 60 * 60 * 1000); // Wednesday noon
    await done(ws, owner, mid(weekAgo(0)));
    await done(ws, owner, mid(weekAgo(0)));
    await done(ws, owner, mid(weekAgo(2)));
    await done(ws, owner, mid(weekAgo(7)));
    expect((await throughput()).items.map((w) => w.count)).toEqual([1, 0, 0, 0, 0, 1, 0, 2]);
  });

  test('weeks run Monday to Sunday in UTC: Sunday night and Monday morning are different weeks', async () => {
    const lastWeek = weekAgo(1);
    await done(ws, owner, new Date(lastWeek.getTime() + 7 * DAY - 60 * 1000)); // Sunday 23:59 UTC, last week
    await done(ws, owner, new Date(lastWeek.getTime() + 7 * DAY)); // Monday 00:00 UTC, this week
    const items = (await throughput()).items;
    expect(items[6].count).toBe(1);
    expect(items[7].count).toBe(1);
  });

  test('work finished before the 8 weeks, or not done, or without a completion date, is not counted', async () => {
    await done(ws, owner, new Date(weekAgo(7).getTime() - 60 * 1000)); // just before the first week
    await prisma.task.create({ data: { title: 'Open', status: 'todo', completedAt: new Date(), userId: owner.id, workspaceId: ws.id } });
    await prisma.task.create({ data: { title: 'Doing', status: 'in_progress', completedAt: new Date(), userId: owner.id, workspaceId: ws.id } });
    await done(ws, owner, null);
    expect((await throughput()).items.reduce((n, w) => n + w.count, 0)).toBe(0);
  });

  test('is scoped to this workspace', async () => {
    await done(otherWs, other, new Date());
    await done(ws, owner, new Date());
    expect((await throughput()).items[7].count).toBe(1);
  });

  test('stays exact on a big project, where the page\'s own task list is cut off', async () => {
    await prisma.task.createMany({ data: Array.from({ length: 205 }, (_, i) => ({ title: `Open ${i}`, status: 'todo', userId: owner.id, workspaceId: ws.id })) });
    await prisma.task.createMany({ data: Array.from({ length: 30 }, (_, i) => ({ title: `Win ${i}`, status: 'done', completedAt: new Date(), userId: owner.id, workspaceId: ws.id })) });
    expect((await throughput()).items[7].count).toBe(30);
  });

  test('an imported backlog dated long ago does not show up as recent work', async () => {
    await request(app).post('/api/tasks/import').set(await as(owner)).send({ workspaceId: ws.id, tasks: [{ title: 'Old backlog', status: 'done', dueDate: '2025-01-15' }] });
    expect((await throughput()).items.reduce((n, w) => n + w.count, 0)).toBe(0);
  });

  test('gives counts only: no titles, ids or anything internal', async () => {
    await done(ws, owner, new Date(), { title: 'Secret deliverable' });
    const res = await request(app).get(`/api/status/${token}`);
    expect(Object.keys(res.body.status.throughput.items[7]).sort()).toEqual(['count', 'start']);
    const text = JSON.stringify(res.body.status.throughput);
    for (const secret of ['Secret deliverable', owner.id, ws.id, 'userId']) expect(text).not.toContain(secret);
  });
});
