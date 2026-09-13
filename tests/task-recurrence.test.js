// Regression coverage for recurring-task spawning (PLAN's regression-debt
// item 3) — including the ownership bug this session found and fixed:
// spawnNextOccurrence used to take the *completer's* userId for the new
// occurrence, not the original task's owner. Harmless while writes were
// owner-only; a real bug the moment a workspace editor could complete a
// teammate's recurring task, which is exactly what Workstream A made
// possible. This test is what stops that regressing silently.
const prisma = require('../src/config/prisma');
const taskService = require('../src/services/task.service');
const { makeUser, makeWorkspaceWithMembers, cleanupUsers } = require('./helpers/fixtures');

describe('recurring task spawning', () => {
  let owner, editor, workspace;

  beforeAll(async () => {
    owner = await makeUser('recur-owner');
    editor = await makeUser('recur-editor');
    workspace = await makeWorkspaceWithMembers(owner, { editors: [editor] });
  });

  afterAll(async () => {
    await cleanupUsers(owner, editor);
    await prisma.$disconnect();
  });

  test('an editor completing a teammate\'s recurring task spawns the next occurrence under the ORIGINAL owner, not the completer', async () => {
    const task = await taskService.create(
      { title: 'Weekly sync', recurrence: 'weekly', workspaceId: workspace.id, assigneeId: editor.id, dueDate: '2026-09-07' },
      owner.id
    );

    const completed = await taskService.update(task.id, { status: 'done' }, editor.id);
    expect(completed.status).toBe('done');

    const spawned = await prisma.task.findFirst({
      // Scoped to this run's workspace, not a bare title match — a title
      // this generic could otherwise collide with orphaned data left by a
      // previous run that crashed before its own afterAll ran (this
      // happened once already this session with permissions.test.js).
      where: { title: 'Weekly sync', workspaceId: workspace.id, id: { not: task.id } },
      orderBy: { createdAt: 'desc' },
    });
    expect(spawned).toBeTruthy();
    expect(spawned.userId).toBe(owner.id); // NOT editor.id — the bug this locks in
    expect(spawned.workspaceId).toBe(workspace.id);
    expect(spawned.assigneeId).toBe(editor.id);
    expect(spawned.status).toBe('todo');
    expect(spawned.completedAt).toBeNull();
  });

  test.each([
    ['daily', '2026-09-10', '2026-09-11'],
    ['weekly', '2026-09-10', '2026-09-17'],
    ['monthly', '2026-09-10', '2026-10-10'],
  ])('%s recurrence advances the due date correctly (%s -> %s)', async (recurrence, from, expected) => {
    const task = await taskService.create({ title: `${recurrence} task`, recurrence, dueDate: from }, owner.id);
    await taskService.update(task.id, { status: 'done' }, owner.id);

    const spawned = await prisma.task.findFirst({
      where: { title: `${recurrence} task`, userId: owner.id, id: { not: task.id } },
    });
    expect(spawned.dueDate.toISOString().slice(0, 10)).toBe(expected);
  });

  test('re-sending status: done on an already-done task does not re-stamp completedAt or spawn a duplicate', async () => {
    const task = await taskService.create({ title: 'One-shot completion', recurrence: 'daily', dueDate: '2026-09-10' }, owner.id);
    const firstComplete = await taskService.update(task.id, { status: 'done' }, owner.id);
    const firstCompletedAt = firstComplete.completedAt;

    // Simulate a duplicate request (double-click, bulk-complete re-selecting
    // an already-done task) arriving after the first has already landed.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const secondComplete = await taskService.update(task.id, { status: 'done' }, owner.id);

    expect(secondComplete.completedAt.getTime()).toBe(firstCompletedAt.getTime());

    const spawnedCount = await prisma.task.count({ where: { title: 'One-shot completion', userId: owner.id, id: { not: task.id } } });
    expect(spawnedCount).toBe(1); // exactly one next-occurrence, not two
  });
});
