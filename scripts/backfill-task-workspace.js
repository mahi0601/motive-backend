// One-off data migration for the workspace_task_assignee schema change
// (see prisma/migrations/20260913035511_task_workspace_assignee). Purely
// additive and idempotent — safe to re-run: only ever touches tasks/users
// that still need it, never deletes or overwrites anything.
//
// What it does, per user with at least one task missing a workspaceId:
//   1. Reuses workspaceService.getDefault() — the exact same lazy
//      "My Workspace" creation logic GET /api/workspaces already uses — so
//      this doesn't reimplement workspace creation with different rules.
//   2. Sets workspaceId = that default workspace, assigneeId = the task's
//      own owner, on every one of that user's tasks still missing a
//      workspaceId. A pre-existing task's owner is trivially its own
//      assignee — this is what makes a solo user's board behave identically
//      before and after (see PLAN's "Regression on the existing solo
//      product" verification requirement).
//
// Run with: node scripts/backfill-task-workspace.js
const prisma = require('../src/config/prisma');
const workspaceService = require('../src/services/workspace.service');

async function main() {
  const userIds = await prisma.task.findMany({
    where: { workspaceId: null },
    distinct: ['userId'],
    select: { userId: true },
  });

  console.log(`Found ${userIds.length} user(s) with tasks needing a workspace backfill.`);

  let usersProcessed = 0;
  let tasksUpdated = 0;

  for (const { userId } of userIds) {
    const workspace = await workspaceService.getDefault(userId);
    const { count } = await prisma.task.updateMany({
      where: { userId, workspaceId: null },
      data: { workspaceId: workspace.id, assigneeId: userId },
    });
    usersProcessed += 1;
    tasksUpdated += count;
  }

  console.log(`Done. ${usersProcessed} user(s) processed, ${tasksUpdated} task(s) backfilled.`);

  const remaining = await prisma.task.count({ where: { workspaceId: null } });
  console.log(`Tasks still missing a workspaceId: ${remaining} (expect 0).`);
}

main()
  .catch((err) => {
    console.error('Backfill failed:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
