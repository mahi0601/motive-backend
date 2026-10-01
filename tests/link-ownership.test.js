// Regression tests for "linking" fields that used to accept any id:
//   - task.assigneeId must be a member of the task's workspace
//   - page.parentId must be a page the caller can write to, in the same workspace
//   - block.parentBlockId must be a block on the same page
//
// Like the other suites, this runs against whatever DATABASE_URL points at
// (CI uses a throwaway Postgres) with throwaway fixtures removed in afterAll.
const prisma = require('../src/config/prisma');
const taskService = require('../src/services/task.service');
const pageService = require('../src/services/page.service');
const blockService = require('../src/services/block.service');
const { makeUser, makeWorkspaceWithMembers, cleanupUsers } = require('./helpers/fixtures');

describe('linking-field ownership checks', () => {
  let owner, editor, outsider, stranger;
  let workspace, strangerWorkspace;
  let pageA, pageB, strangerPage;

  beforeAll(async () => {
    owner = await makeUser('owner');
    editor = await makeUser('editor');
    outsider = await makeUser('outsider'); // not in `workspace`
    stranger = await makeUser('stranger'); // owns a separate workspace
    workspace = await makeWorkspaceWithMembers(owner, { editors: [editor] });
    strangerWorkspace = await makeWorkspaceWithMembers(stranger);

    pageA = await pageService.create({ title: 'A', workspaceId: workspace.id }, owner.id);
    pageB = await pageService.create({ title: 'B', workspaceId: workspace.id }, owner.id);
    strangerPage = await pageService.create({ title: 'Private', workspaceId: strangerWorkspace.id }, stranger.id);
  });

  afterAll(async () => {
    await cleanupUsers(owner, editor, outsider, stranger);
    await prisma.$disconnect();
  });

  describe('task.assigneeId', () => {
    test('rejects an assignee who is not a workspace member on create', async () => {
      await expect(
        taskService.create({ title: 't', workspaceId: workspace.id, assigneeId: outsider.id }, owner.id)
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    test('rejects an assignee who is not a workspace member on update', async () => {
      const task = await taskService.create({ title: 't', workspaceId: workspace.id }, owner.id);
      await expect(taskService.update(task.id, { assigneeId: outsider.id }, owner.id)).rejects.toMatchObject({
        statusCode: 400,
      });
    });

    test('accepts a workspace member and allows clearing the assignee', async () => {
      const task = await taskService.create({ title: 't', workspaceId: workspace.id, assigneeId: editor.id }, owner.id);
      expect(task.assigneeId).toBe(editor.id);
      const cleared = await taskService.update(task.id, { assigneeId: null }, owner.id);
      expect(cleared.assigneeId).toBeNull();
    });
  });

  describe('page.parentId', () => {
    test("rejects nesting under a page the caller can't access (create)", async () => {
      await expect(
        pageService.create({ title: 'x', workspaceId: workspace.id, parentId: strangerPage.id }, owner.id)
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    test("rejects moving a page under one the caller can't access (update)", async () => {
      await expect(pageService.update(pageA.id, { parentId: strangerPage.id }, owner.id)).rejects.toMatchObject({
        statusCode: 404,
      });
    });

    test('rejects a parent in a different workspace even if the caller can write to both', async () => {
      const other = await makeWorkspaceWithMembers(owner);
      const otherPage = await pageService.create({ title: 'other', workspaceId: other.id }, owner.id);
      await expect(pageService.update(pageA.id, { parentId: otherPage.id }, owner.id)).rejects.toMatchObject({
        statusCode: 400,
      });
    });

    test('accepts a parent in the same workspace', async () => {
      const child = await pageService.create({ title: 'child', workspaceId: workspace.id, parentId: pageA.id }, owner.id);
      expect(child.parentId).toBe(pageA.id);
    });
  });

  describe('block.parentBlockId', () => {
    let blockOnA, blockOnB;

    beforeAll(async () => {
      blockOnA = await blockService.create(pageA.id, { type: 'toggle', content: {} }, owner.id);
      blockOnB = await blockService.create(pageB.id, { type: 'toggle', content: {} }, owner.id);
    });

    test('rejects a parent block that lives on another page (create)', async () => {
      await expect(
        blockService.create(pageA.id, { type: 'paragraph', content: {}, parentBlockId: blockOnB.id }, owner.id)
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    test('rejects a parent block that lives on another page (update)', async () => {
      const child = await blockService.create(pageA.id, { type: 'paragraph', content: {} }, owner.id);
      await expect(blockService.update(child.id, { parentBlockId: blockOnB.id }, owner.id)).rejects.toMatchObject({
        statusCode: 400,
      });
    });

    test('rejects a block parenting itself', async () => {
      await expect(blockService.update(blockOnA.id, { parentBlockId: blockOnA.id }, owner.id)).rejects.toMatchObject({
        statusCode: 400,
      });
    });

    test('accepts a parent block on the same page and allows un-nesting', async () => {
      const child = await blockService.create(
        pageA.id,
        { type: 'paragraph', content: {}, parentBlockId: blockOnA.id },
        owner.id
      );
      expect(child.parentBlockId).toBe(blockOnA.id);
      const unnested = await blockService.update(child.id, { parentBlockId: null }, owner.id);
      expect(unnested.parentBlockId).toBeNull();
    });
  });
});
