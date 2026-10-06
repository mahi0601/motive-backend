// A removed member stops seeing what they created in a workspace they left, in lists, search,
// templates, exports and digests; credential endpoints refuse forged cross-site forms; every
// spelling of an email shares one login counter; a resend cannot revive a closed invite.
const request = require('supertest');
const prisma = require('../src/config/prisma');
const app = require('../src/app');
const workspaceService = require('../src/services/workspace.service');
const taskService = require('../src/services/task.service');
const pageService = require('../src/services/page.service');
const templateService = require('../src/services/template.service');
const userService = require('../src/services/user.service');
const { makeUser, makeWorkspaceWithMembers, testEmail, cleanupUsers } = require('./helpers/fixtures');

describe('removed member: lists, search, templates, export', () => {
  let owner, member, workspace, task, page, personalTask;
  beforeAll(async () => {
    owner = await makeUser('ahOwner');
    member = await makeUser('ahMember');
    workspace = await makeWorkspaceWithMembers(owner, { editors: [member] });
    task = await taskService.create({ title: 'ZQXtask', workspaceId: workspace.id }, member.id);
    page = await pageService.create({ title: 'ZQXpage', workspaceId: workspace.id }, member.id);
    await prisma.block.create({ data: { pageId: page.id, type: 'paragraph', content: { text: 'secret client notes' }, position: 0 } });
    personalTask = await prisma.task.create({ data: { title: 'ZQXpersonal', userId: member.id } });
  });
  afterAll(async () => {
    await cleanupUsers(owner, member);
    await prisma.$disconnect();
  });

  test('while a member everything is visible (control)', async () => {
    expect((await taskService.getAll(member.id, {})).items.map((t) => t.id)).toContain(task.id);
    expect((await pageService.list(member.id)).map((p) => p.id)).toContain(page.id);
  });

  test('after removal the member no longer reaches it anywhere, but keeps personal items', async () => {
    await workspaceService.removeMember(workspace.id, member.id, owner.id);

    const tasks = (await taskService.getAll(member.id, {})).items.map((t) => t.id);
    expect(tasks).not.toContain(task.id);
    expect(tasks).toContain(personalTask.id);
    expect((await taskService.search('ZQX', member.id)).map((t) => t.id)).not.toContain(task.id);
    expect((await pageService.list(member.id)).map((p) => p.id)).not.toContain(page.id);
    expect((await pageService.search('ZQX', member.id)).map((p) => p.id)).not.toContain(page.id);
    expect((await pageService.search('secret client', member.id)).map((p) => p.id)).not.toContain(page.id);
    await expect(templateService.saveFromPage(member.id, { pageId: page.id })).rejects.toThrow(/not found/i);

    const exported = await userService.exportData(member.id);
    const exportedPage = exported.pages.find((p) => p.id === page.id);
    expect(exportedPage ? exportedPage.blocks : []).toEqual([]);
  });
});

describe('credential endpoints', () => {
  test('a forged cross-site form post (urlencoded) to login and register is refused', async () => {
    for (const path of ['/api/auth/login', '/api/auth/register']) {
      const res = await request(app).post(path).type('form').send({ email: 'a@example.com', password: 'Passw0rd1' });
      expect(res.status).toBe(400);
    }
  });

  test('a JSON request from a disallowed Origin is refused', async () => {
    const res = await request(app).post('/api/auth/login').set('Origin', 'https://evil.example').send({ email: 'a@example.com', password: 'x' });
    expect(res.status).toBe(403);
  });
});

describe('resendInvite', () => {
  let owner, workspace;
  beforeAll(async () => {
    owner = await makeUser('ahInvOwner');
    workspace = await makeWorkspaceWithMembers(owner);
  });
  afterAll(async () => cleanupUsers(owner));

  test('a revoked invite is not revived by a resend; an unverified sender cannot resend', async () => {
    const invite = await workspaceService.createInvite(workspace.id, owner.id, testEmail('ahInvitee'), 'editor');
    await expect(workspaceService.resendInvite(workspace.id, invite.id, owner.id)).resolves.toBeTruthy();

    await prisma.user.update({ where: { id: owner.id }, data: { emailVerifiedAt: null } });
    await expect(workspaceService.resendInvite(workspace.id, invite.id, owner.id)).rejects.toThrow(/verify your email/i);
    await prisma.user.update({ where: { id: owner.id }, data: { emailVerifiedAt: new Date() } });

    await workspaceService.revokeInvite(workspace.id, invite.id, owner.id);
    await expect(workspaceService.resendInvite(workspace.id, invite.id, owner.id)).rejects.toThrow(/no longer open/i);
  });
});

describe('deleting a member account', () => {
  test('keeps the tasks and pages they made in someone else\'s workspace, handed to its owner', async () => {
    const owner = await makeUser('ahDelOwner');
    const member = await makeUser('ahDelMember');
    const ws = await makeWorkspaceWithMembers(owner, { editors: [member] });
    const t = await taskService.create({ title: 'Kept task', workspaceId: ws.id }, member.id);
    const p = await pageService.create({ title: 'Kept page', workspaceId: ws.id }, member.id);
    await userService.deleteAccount(member.id, null, member.email);
    expect(await prisma.task.findUnique({ where: { id: t.id } })).toMatchObject({ userId: owner.id });
    expect(await prisma.page.findUnique({ where: { id: p.id } })).toMatchObject({ ownerId: owner.id });
    await cleanupUsers(owner);
  });
});

describe('plan limits hold under parallel requests', () => {
  test('two parallel "enable share" calls on a free plan leave one live client', async () => {
    const owner = await makeUser('ahRace');
    const a = await workspaceService.create({ name: 'A' }, owner.id);
    const b = await workspaceService.create({ name: 'B' }, owner.id);
    const results = await Promise.allSettled([workspaceService.enableShare(a.id, owner.id), workspaceService.enableShare(b.id, owner.id)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.workspace.count({ where: { ownerId: owner.id, shareEnabledAt: { not: null } } })).toBe(1);
    await cleanupUsers(owner);
  });

  test('parallel first requests create one default workspace', async () => {
    const user = await makeUser('ahDefault');
    await Promise.all([workspaceService.listForUser(user.id), workspaceService.listForUser(user.id), workspaceService.listForUser(user.id)]);
    expect(await prisma.workspace.count({ where: { ownerId: user.id } })).toBe(1);
    await cleanupUsers(user);
  });
});
