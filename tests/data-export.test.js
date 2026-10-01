// "Download my data": everything the account owns or authored, in one JSON
// document, and nothing that belongs to somebody else or that is a credential.
const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/prisma');
const taskService = require('../src/services/task.service');
const pageService = require('../src/services/page.service');
const blockService = require('../src/services/block.service');
const commentService = require('../src/services/comment.service');
const { hashPassword } = require('../src/utils/password.util');
const { accessTokenFor, makeUser, makeWorkspaceWithMembers, cleanupUsers } = require('./helpers/fixtures');

describe('GET /api/users/me/export', () => {
  let alice, bob, ws, aliceTask, bobTask, alicePage;

  beforeAll(async () => {
    alice = await makeUser('exportAlice', { password: await hashPassword('x-password-1'), stripeCustomerId: 'cus_SECRET' });
    bob = await makeUser('exportBob');
    ws = await makeWorkspaceWithMembers(alice, { editors: [bob] });
    aliceTask = await taskService.create({ title: 'Alice task', workspaceId: ws.id }, alice.id);
    bobTask = await taskService.create({ title: "Bob's private-ish task", workspaceId: ws.id }, bob.id);
    alicePage = await pageService.create({ title: 'Alice page', workspaceId: ws.id }, alice.id);
    await blockService.create(alicePage.id, { type: 'paragraph', content: { text: 'hello block' } }, alice.id);
    await commentService.addComment(aliceTask.id, alice.id, 'alice wrote this');
    await commentService.addComment(aliceTask.id, bob.id, 'bob wrote this');
    await prisma.file.create({ data: { name: 'a.png', url: 'https://cdn.test/a.png', uploadedBy: alice.id, taskId: aliceTask.id } });
  });
  afterAll(async () => {
    await cleanupUsers(alice, bob);
    await prisma.$disconnect();
  });

  const get = async (user) => request(app).get('/api/users/me/export').set('Authorization', `Bearer ${await accessTokenFor(user)}`);

  test('includes what clients sent to workspaces the user owns, and not feedback on someone else\'s', async () => {
    // A separate owner: the export is limited to one per hour per account, and
    // the tests above already used alice's.
    const dana = await makeUser('exportDana');
    const erin = await makeUser('exportErin');
    try {
      const danaWs = await makeWorkspaceWithMembers(dana);
      const erinWs = await makeWorkspaceWithMembers(erin);
      await prisma.clientFeedback.create({ data: { workspaceId: danaWs.id, kind: 'comment', authorName: 'Client Cat', message: 'looks great' } });
      await prisma.clientFeedback.create({ data: { workspaceId: erinWs.id, kind: 'comment', authorName: 'Other Client', message: 'erin only' } });
      const mine = (await get(dana)).body.clientFeedback;
      expect(mine.map((f) => f.message)).toEqual(['looks great']);
      expect(JSON.stringify(mine)).not.toContain('erin only');
    } finally {
      await cleanupUsers(dana, erin);
    }
  });

  test('requires authentication', async () => {
    expect((await request(app).get('/api/users/me/export')).status).toBe(401);
  });

  test('contains what the user owns or wrote, as a downloadable JSON file', async () => {
    const res = await get(alice);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="motive-export-.*\.json"/);
    expect(res.headers['cache-control']).toMatch(/no-store/);
    const d = res.body;
    expect(d.exportedAt).toBeTruthy();
    expect(d.profile).toMatchObject({ id: alice.id, email: alice.email });
    expect(d.tasks.map((t) => t.title)).toContain('Alice task');
    expect(d.pages.map((p) => p.title)).toContain('Alice page');
    expect(d.pages.find((p) => p.id === alicePage.id).blocks[0].content).toMatchObject({ text: 'hello block' });
    expect(d.comments.map((c) => c.text)).toEqual(['alice wrote this']);
    expect(d.files.map((f) => f.name)).toEqual(['a.png']);
    expect(d.workspaces.map((w) => w.id)).toContain(ws.id);
  });

  test("does not include another member's tasks or comments, nor anyone else's email", async () => {
    const out = JSON.stringify((await get(alice)).body);
    expect(out).not.toContain("Bob's private-ish task");
    expect(out).not.toContain('bob wrote this');
    expect(out).not.toContain(bob.email);
    expect(bobTask.id && out).not.toContain(bobTask.id);
  });

  test('never includes credentials or billing identifiers', async () => {
    const out = JSON.stringify((await get(alice)).body);
    expect(out).not.toMatch(/"password"|passwordHash|cus_SECRET|stripeCustomerId|stripeSubscriptionId|tokenVersion|tokenHash|shareTokenHash/);
  });

  test('is limited to one export per hour per account, and the export is audited', async () => {
    const carol = await makeUser('exportCarol');
    try {
      expect((await get(carol)).status).toBe(200);
      expect((await get(carol)).status).toBe(429);
      // a different account is unaffected
      expect((await get(bob)).status).toBe(200);
      expect(await prisma.securityEvent.count({ where: { type: 'data_exported', actorId: carol.id } })).toBe(1);
    } finally {
      await cleanupUsers(carol);
    }
  });
});
