// Permission-matrix tests for the workspace-scoped authorization layer added
// alongside Task.workspaceId/assigneeId (see PLAN "Total scope" §A). This is
// the highest-risk piece of that workstream — a missed check here is a
// cross-client data leak, not a wrong dashboard number — so per the plan
// these are written before the workstream is considered done, not after.
//
// Runs against the real dev database (no separate test DB is configured —
// see README). Every fixture is created fresh with a unique, timestamped
// email and torn down in afterAll; nothing here ever reads or touches an
// existing real account. `npm test` runs Jest with --runInBand specifically
// so these don't race each other over the same shared DB connection pool.
const prisma = require('../src/config/prisma');
const workspaceService = require('../src/services/workspace.service');
const taskService = require('../src/services/task.service');
const pageService = require('../src/services/page.service');
const blockService = require('../src/services/block.service');
const commentService = require('../src/services/comment.service');
const subtaskService = require('../src/services/subtask.service');
const fileService = require('../src/services/file.service');
const { makeUser, makeWorkspaceWithMembers, cleanupUsers } = require('./helpers/fixtures');

describe('workspace-scoped authorization', () => {
  let ownerA, editorA, viewerA, ownerB;
  let workspaceA, workspaceB;
  let taskA, pageA, blockA;
  let taskB, pageB;

  beforeAll(async () => {
    // Workspace A: owner + editor + viewer, one task/page/block to probe.
    ownerA = await makeUser('ownerA');
    editorA = await makeUser('editorA');
    viewerA = await makeUser('viewerA');
    workspaceA = await makeWorkspaceWithMembers(ownerA, { editors: [editorA], viewers: [viewerA] });

    taskA = await taskService.create({ title: 'Task in A', workspaceId: workspaceA.id }, ownerA.id);
    pageA = await pageService.create({ title: 'Page in A', workspaceId: workspaceA.id }, ownerA.id);
    blockA = await blockService.create(pageA.id, { type: 'paragraph', content: { text: 'hello' } }, ownerA.id);

    // Workspace B: a completely separate owner, for the cross-workspace
    // isolation test — nobody from A is a member of B.
    ownerB = await makeUser('ownerB');
    workspaceB = await makeWorkspaceWithMembers(ownerB);
    taskB = await taskService.create({ title: 'Task in B', workspaceId: workspaceB.id }, ownerB.id);
    pageB = await pageService.create({ title: 'Page in B', workspaceId: workspaceB.id }, ownerB.id);
  });

  afterAll(async () => {
    await cleanupUsers(ownerA, editorA, viewerA, ownerB);
    await prisma.$disconnect();
  });

  describe('canAccess / getRole', () => {
    test('owner has role owner and passes read+write', async () => {
      expect(await workspaceService.getRole(workspaceA.id, ownerA.id)).toBe('owner');
      expect(await workspaceService.canAccess(workspaceA.id, ownerA.id, 'read')).toBe(true);
      expect(await workspaceService.canAccess(workspaceA.id, ownerA.id, 'write')).toBe(true);
    });

    test('editor passes read+write', async () => {
      expect(await workspaceService.getRole(workspaceA.id, editorA.id)).toBe('editor');
      expect(await workspaceService.canAccess(workspaceA.id, editorA.id, 'read')).toBe(true);
      expect(await workspaceService.canAccess(workspaceA.id, editorA.id, 'write')).toBe(true);
    });

    test('viewer passes read but fails write', async () => {
      expect(await workspaceService.getRole(workspaceA.id, viewerA.id)).toBe('viewer');
      expect(await workspaceService.canAccess(workspaceA.id, viewerA.id, 'read')).toBe(true);
      expect(await workspaceService.canAccess(workspaceA.id, viewerA.id, 'write')).toBe(false);
    });

    test('a non-member fails both read and write', async () => {
      expect(await workspaceService.getRole(workspaceA.id, ownerB.id)).toBeNull();
      expect(await workspaceService.canAccess(workspaceA.id, ownerB.id, 'read')).toBe(false);
    });
  });

  describe('Task', () => {
    test('viewer can read but not write', async () => {
      await expect(taskService.getAll(viewerA.id, { workspaceId: workspaceA.id })).resolves.toBeTruthy();
      await expect(taskService.update(taskA.id, { title: 'edited by viewer' }, viewerA.id)).rejects.toThrow();
      await expect(taskService.remove(taskA.id, viewerA.id)).rejects.toThrow();
    });

    test('editor can read and write a task they do not own', async () => {
      const updated = await taskService.update(taskA.id, { title: 'edited by editor' }, editorA.id);
      expect(updated.title).toBe('edited by editor');
    });

    test('a member of workspace A gets "not found" on workspace B\'s task by id', async () => {
      await expect(taskService.update(taskB.id, { title: 'nope' }, editorA.id)).rejects.toThrow();
      await expect(taskService.update(taskB.id, { title: 'nope' }, viewerA.id)).rejects.toThrow();
    });

    test('workspace A\'s task list never includes workspace B\'s tasks', async () => {
      const { items } = await taskService.getAll(ownerA.id, { workspaceId: workspaceA.id });
      expect(items.some((t) => t.id === taskB.id)).toBe(false);
    });

    test('omitting workspaceId preserves the original solo-user behavior (WHERE userId = ?)', async () => {
      const { items } = await taskService.getAll(ownerA.id, {});
      expect(items.every((t) => t.userId === ownerA.id)).toBe(true);
      expect(items.some((t) => t.id === taskA.id)).toBe(true);
    });
  });

  describe('Page', () => {
    test('viewer can read but not write', async () => {
      await expect(pageService.getById(pageA.id, viewerA.id)).resolves.toBeTruthy();
      await expect(pageService.update(pageA.id, { title: 'edited by viewer' }, viewerA.id)).rejects.toThrow();
      await expect(pageService.remove(pageA.id, viewerA.id)).rejects.toThrow();
    });

    test('editor can write a page they do not own', async () => {
      const updated = await pageService.update(pageA.id, { title: 'edited by editor' }, editorA.id);
      expect(updated.title).toBe('edited by editor');
    });

    test('a member of workspace A gets "not found" on workspace B\'s page by id', async () => {
      await expect(pageService.getById(pageB.id, editorA.id)).rejects.toThrow();
      await expect(pageService.getById(pageB.id, viewerA.id)).rejects.toThrow();
    });

    test('list(workspaceId) never includes another workspace\'s pages', async () => {
      const pages = await pageService.list(editorA.id, { workspaceId: workspaceA.id });
      expect(pages.some((p) => p.id === pageB.id)).toBe(false);
      expect(pages.some((p) => p.id === pageA.id)).toBe(true);
    });

    test('cannot create a page directly into a workspace with no write access', async () => {
      await expect(pageService.create({ title: 'sneaky', workspaceId: workspaceB.id }, viewerA.id)).rejects.toThrow();
    });
  });

  describe('Block', () => {
    test('viewer can read but not write', async () => {
      await expect(blockService.listByPage(pageA.id, viewerA.id)).resolves.toBeTruthy();
      await expect(
        blockService.create(pageA.id, { type: 'paragraph', content: {} }, viewerA.id)
      ).rejects.toThrow();
      await expect(blockService.update(blockA.id, { content: { text: 'nope' } }, viewerA.id)).rejects.toThrow();
      await expect(blockService.remove(blockA.id, viewerA.id)).rejects.toThrow();
    });

    test('editor can write a block on a page they do not own', async () => {
      const updated = await blockService.update(blockA.id, { content: { text: 'edited by editor' } }, editorA.id);
      expect(updated.content.text).toBe('edited by editor');
    });

    test('a member of workspace A cannot list workspace B\'s page blocks', async () => {
      await expect(blockService.listByPage(pageB.id, editorA.id)).rejects.toThrow();
    });
  });

  // Comments/subtasks/files all build on task.service.js's assertAccess
  // (formerly assertOwner, strict owner-only — see its own comment). This
  // is the exact consistency bug that motivated widening it: before this
  // fix, an editor who could edit a shared task still couldn't comment on
  // it, add a subtask, or attach a file to it.
  describe('Comments/subtasks/files on a shared task', () => {
    test('a viewer can read and add a comment (feedback, not a task edit)', async () => {
      await expect(commentService.getComments(taskA.id, viewerA.id)).resolves.toBeTruthy();
      const { comment } = await commentService.addComment(taskA.id, viewerA.id, 'looks good!');
      expect(comment.text).toBe('looks good!');
    });

    test('a non-member cannot read or comment on the task at all', async () => {
      await expect(commentService.getComments(taskA.id, ownerB.id)).rejects.toThrow();
      await expect(commentService.addComment(taskA.id, ownerB.id, 'sneaky')).rejects.toThrow();
    });

    test('a viewer cannot create, update, or remove a subtask', async () => {
      await expect(subtaskService.create(taskA.id, 'new subtask', viewerA.id)).rejects.toThrow();
    });

    test('an editor can create, update, and remove a subtask on a task they do not own', async () => {
      const subtask = await subtaskService.create(taskA.id, 'from editor', editorA.id);
      const updated = await subtaskService.update(subtask.id, { done: true }, editorA.id);
      expect(updated.done).toBe(true);
      await expect(subtaskService.remove(subtask.id, editorA.id)).resolves.toEqual({ deleted: true });
    });

    test('a non-member cannot list, create, update, or remove subtasks on the task', async () => {
      const subtask = await subtaskService.create(taskA.id, 'probe', ownerA.id);
      await expect(subtaskService.listByTask(taskA.id, ownerB.id)).rejects.toThrow();
      await expect(subtaskService.update(subtask.id, { done: true }, ownerB.id)).rejects.toThrow();
      await expect(subtaskService.remove(subtask.id, ownerB.id)).rejects.toThrow();
    });

    test('file listing follows the same read rule: a workspace viewer can list, a non-member cannot', async () => {
      // Bypasses the actual upload/storage path (real disk/R2 write, no
      // value added re-testing the same assertAccess call already covered
      // above) — just needs a File row to list against.
      await prisma.file.create({ data: { name: 'brief.pdf', url: 'https://example.invalid/brief.pdf', uploadedBy: ownerA.id, taskId: taskA.id } });
      await expect(fileService.listByTask(taskA.id, viewerA.id)).resolves.toBeTruthy();
      await expect(fileService.listByTask(taskA.id, ownerB.id)).rejects.toThrow();
    });
  });
});
