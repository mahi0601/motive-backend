// A creator's "always has access" shortcut used to outlive their membership: a
// member who was removed from a workspace could still read, edit and delete the
// tasks/pages they had created in it, and read everyone else's comments on them.
// Creator access now only applies to personal items (no workspace) or while the
// creator still holds a role in the item's workspace.
const prisma = require('../src/config/prisma');
const workspaceService = require('../src/services/workspace.service');
const taskService = require('../src/services/task.service');
const pageService = require('../src/services/page.service');
const blockService = require('../src/services/block.service');
const commentService = require('../src/services/comment.service');
const fileService = require('../src/services/file.service');
const { makeUser, makeWorkspaceWithMembers, cleanupUsers } = require('./helpers/fixtures');

describe('removed workspace members lose access to what they created there', () => {
  let owner, member, workspace;
  let task, page, personalTask, personalPage;

  beforeAll(async () => {
    owner = await makeUser('rmOwner');
    member = await makeUser('rmMember');
    workspace = await makeWorkspaceWithMembers(owner, { editors: [member] });
    task = await taskService.create({ title: 'Made by member', workspaceId: workspace.id }, member.id);
    page = await pageService.create({ title: 'Made by member', workspaceId: workspace.id }, member.id);
    // Legacy personal rows predate workspaces and have no workspaceId (the
    // column is still nullable). Created directly: the service would file a new
    // item under the member's default workspace, which may be the shared one.
    personalTask = await prisma.task.create({ data: { title: 'Personal', userId: member.id } });
    personalPage = await prisma.page.create({ data: { title: 'Personal', ownerId: member.id } });
  });

  afterAll(async () => {
    await cleanupUsers(owner, member);
    await prisma.$disconnect();
  });

  test('while still a member, the creator has access (control)', async () => {
    await expect(taskService.update(task.id, { title: 'still ok' }, member.id)).resolves.toBeTruthy();
    await expect(pageService.getById(page.id, member.id)).resolves.toBeTruthy();
  });

  test('after removal: no read, write or delete on their own workspace task/page, and no comments/files/blocks', async () => {
    await workspaceService.removeMember(workspace.id, member.id, owner.id);

    await expect(taskService.update(task.id, { title: 'nope' }, member.id)).rejects.toThrow(/not found/i);
    await expect(taskService.remove(task.id, member.id)).rejects.toThrow(/not found/i);
    await expect(pageService.getById(page.id, member.id)).rejects.toThrow(/not found/i);
    await expect(blockService.create(page.id, { type: 'paragraph', content: { text: 'x' } }, member.id)).rejects.toThrow(/not found/i);
    await expect(commentService.getComments(task.id, member.id)).rejects.toThrow(/not found/i);
    await expect(commentService.addComment(task.id, member.id, 'hi')).rejects.toThrow(/not found/i);
    await expect(fileService.listByTask(task.id, member.id)).rejects.toThrow(/not found/i);
  });

  test('the workspace owner is unaffected', async () => {
    await expect(taskService.update(task.id, { title: 'owner edit' }, owner.id)).resolves.toBeTruthy();
    await expect(pageService.getById(page.id, owner.id)).resolves.toBeTruthy();
  });

  test('personal items (no workspace) still belong to their creator', async () => {
    await expect(taskService.update(personalTask.id, { title: 'mine' }, member.id)).resolves.toBeTruthy();
    await expect(pageService.getById(personalPage.id, member.id)).resolves.toBeTruthy();
  });
});
