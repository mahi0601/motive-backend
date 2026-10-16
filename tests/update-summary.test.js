// The owner's progress-update summary: the weekly email's facts as data, for a note sent by hand.
// Owner only, nothing sent, nothing confidential (no comments, people, files or share link).
const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/prisma');
const { accessTokenFor, makeUser, makeWorkspaceWithMembers, cleanupUsers } = require('./helpers/fixtures');

const DAY = 24 * 60 * 60 * 1000;

describe('update summary', () => {
  let owner, editor, stranger, ws;
  const get = async (user, id = ws.id) => request(app).get(`/api/workspaces/${id}/update-summary`).set({ Authorization: `Bearer ${await accessTokenFor(user)}` });

  beforeAll(async () => {
    owner = await makeUser('usOwner');
    editor = await makeUser('usEditor');
    stranger = await makeUser('usStranger');
    ws = await makeWorkspaceWithMembers(owner, { editors: [editor] });
  });
  afterAll(async () => {
    await cleanupUsers(owner, editor, stranger);
    await prisma.$disconnect();
  });

  test('a client with nothing finished or under way has nothing to share (422)', async () => {
    const res = await get(owner);
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/nothing/i);
  });

  test('returns what finished this week, what is under way, what is due soon and the next milestone', async () => {
    const now = Date.now();
    const mk = (title, extra) => prisma.task.create({ data: { title, userId: owner.id, workspaceId: ws.id, position: 0, ...extra } });
    await mk('Homepage design', { status: 'done', completedAt: new Date(now - 2 * DAY) });
    await mk('Old finished thing', { status: 'done', completedAt: new Date(now - 30 * DAY) });
    await mk('Build pages', { status: 'in_progress' });
    await mk('Mobile testing', { status: 'todo', dueDate: new Date(now + 5 * DAY) });
    await mk('Far future task', { status: 'todo', dueDate: new Date(now + 60 * DAY) });
    await prisma.milestone.create({ data: { workspaceId: ws.id, title: 'Launch', date: new Date(now + 20 * DAY), position: 0 } });
    await prisma.comment.create({ data: { taskId: (await prisma.task.findFirst({ where: { workspaceId: ws.id } })).id, userId: editor.id, text: 'PRIVATE COMMENT' } });

    const res = await get(owner);
    expect(res.status).toBe(200);
    const s = res.body.summary;
    expect(s).toMatchObject({ shippedCount: 1, shipped: ['Homepage design'], inProgress: ['Build pages'], windowDays: 7 });
    expect(s.upcoming.map((t) => t.title)).toEqual(['Mobile testing']);
    expect(s.milestone.title).toBe('Launch');
    const text = JSON.stringify(res.body);
    for (const leak of ['PRIVATE COMMENT', owner.email, editor.email, 'Far future', 'Old finished']) expect(text).not.toContain(leak);
  });

  test('only the owner may ask: an editor and a stranger are refused, and no login is 401', async () => {
    expect((await get(editor)).status).toBe(403);
    expect((await get(stranger)).status).toBe(403);
    expect((await request(app).get(`/api/workspaces/${ws.id}/update-summary`)).status).toBe(401);
  });
});
