// "Shipped this week" on the public status page: what finished in the last 7 days, so a
// client has a reason to come back. It is computed on its own (an exact count and the
// newest few), because the page's task list is capped and lists done work last, so on a
// big project the recent wins would be the first thing cut. Titles and dates only, like
// the rest of the page.
const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/prisma');
const { accessTokenFor, makeUser, makeWorkspaceWithMembers, cleanupUsers } = require('./helpers/fixtures');

const DAY = 24 * 60 * 60 * 1000;
const ago = (ms) => new Date(Date.now() - ms);

describe('shipped this week on the public status page', () => {
  let owner, other, ws, otherWs, token;
  const as = async (u) => ({ Authorization: `Bearer ${await accessTokenFor(u)}` });
  const recent = async (t = token) => (await request(app).get(`/api/status/${t}`)).body.status.recent;
  const task = (workspace, user, data) =>
    prisma.task.create({ data: { title: 'T', userId: user.id, workspaceId: workspace.id, ...data } });

  beforeAll(async () => {
    owner = await makeUser('shipOwner', { isPro: true });
    other = await makeUser('shipOther', { isPro: true });
    ws = await makeWorkspaceWithMembers(owner);
    otherWs = await makeWorkspaceWithMembers(other);
    token = (await request(app).post(`/api/workspaces/${ws.id}/share`).set(await as(owner))).body.share.token;
    await prisma.workspace.update({ where: { id: ws.id }, data: { name: 'Acme Redesign' } }); // the fixture name holds the owner id
  });
  beforeEach(async () => {
    await prisma.task.deleteMany({ where: { workspaceId: { in: [ws.id, otherWs.id] } } });
  });
  afterAll(async () => {
    await cleanupUsers(owner, other);
    await prisma.$disconnect();
  });

  test('an empty page reports nothing shipped', async () => {
    expect(await recent()).toEqual({ days: 7, count: 0, items: [] });
  });

  test('tasks done in the last 7 days are listed, newest first, with title and date only', async () => {
    await task(ws, owner, { title: 'Older win', status: 'done', completedAt: ago(5 * DAY) });
    await task(ws, owner, { title: 'Newest win', status: 'done', completedAt: ago(1 * DAY) });
    await task(ws, owner, { title: 'Middle win', status: 'done', completedAt: ago(3 * DAY) });
    const r = await recent();
    expect(r.count).toBe(3);
    expect(r.items.map((i) => i.title)).toEqual(['Newest win', 'Middle win', 'Older win']);
    expect(Object.keys(r.items[0]).sort()).toEqual(['completedAt', 'title']);
  });

  test('the window is 7 days: just inside counts, just outside does not', async () => {
    await task(ws, owner, { title: 'Inside', status: 'done', completedAt: ago(7 * DAY - 60 * 60 * 1000) });
    await task(ws, owner, { title: 'Outside', status: 'done', completedAt: ago(7 * DAY + 60 * 60 * 1000) });
    expect((await recent()).items.map((i) => i.title)).toEqual(['Inside']);
  });

  test('only done tasks with a completion date count', async () => {
    await task(ws, owner, { title: 'Open', status: 'todo', completedAt: ago(1 * DAY) });
    await task(ws, owner, { title: 'Doing', status: 'in_progress', completedAt: ago(1 * DAY) });
    await task(ws, owner, { title: 'Done, no date', status: 'done', completedAt: null });
    expect(await recent()).toMatchObject({ count: 0, items: [] });
  });

  test('the list is the newest 10, but the count is exact', async () => {
    await prisma.task.createMany({
      data: Array.from({ length: 13 }, (_, i) => ({ title: `Win ${i}`, status: 'done', completedAt: ago((i + 1) * 60 * 60 * 1000), userId: owner.id, workspaceId: ws.id })),
    });
    const r = await recent();
    expect(r.count).toBe(13);
    expect(r.items).toHaveLength(10);
    expect(r.items[0].title).toBe('Win 0');
  });

  test('still correct when the page\'s own task list is cut off (more than 200 tasks)', async () => {
    await prisma.task.createMany({ data: Array.from({ length: 205 }, (_, i) => ({ title: `Open ${i}`, status: 'todo', userId: owner.id, workspaceId: ws.id })) });
    await task(ws, owner, { title: 'Recent win', status: 'done', completedAt: ago(1 * DAY) });
    const res = await request(app).get(`/api/status/${token}`);
    expect(res.body.status.truncated).toBe(true);
    expect(res.body.status.tasks.some((t) => t.title === 'Recent win')).toBe(false); // cut from the list...
    expect(res.body.status.recent.items.map((i) => i.title)).toEqual(['Recent win']); // ...but not from this
  });

  test('only this workspace\'s work is counted', async () => {
    await task(otherWs, other, { title: 'Someone else', status: 'done', completedAt: ago(1 * DAY) });
    await task(ws, owner, { title: 'Mine', status: 'done', completedAt: ago(1 * DAY) });
    expect((await recent()).items.map((i) => i.title)).toEqual(['Mine']);
  });

  test('an imported done task dated long ago is not counted as shipped this week', async () => {
    await request(app).post('/api/tasks/import').set(await as(owner)).send({ workspaceId: ws.id, tasks: [{ title: 'Old backlog', status: 'done', dueDate: '2026-01-15' }] });
    expect(await recent()).toMatchObject({ count: 0 });
  });

  test('adds nothing internal to the public response', async () => {
    await task(ws, owner, { title: 'Win', status: 'done', completedAt: ago(1 * DAY) });
    const text = JSON.stringify((await request(app).get(`/api/status/${token}`)).body);
    for (const secret of [owner.id, owner.email, ws.id, 'userId', 'workspaceId', 'shareTokenHash']) expect(text).not.toContain(secret);
  });

  test('the preview flag does not change it', async () => {
    await task(ws, owner, { title: 'Win', status: 'done', completedAt: ago(1 * DAY) });
    const normal = (await request(app).get(`/api/status/${token}`)).body.status.recent;
    const preview = (await request(app).get(`/api/status/${token}?preview=1`)).body.status.recent;
    expect(preview).toEqual(normal);
  });
});
