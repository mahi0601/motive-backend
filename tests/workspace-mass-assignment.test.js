// Regression test: workspaceService.create must ignore everything except the
// allowlisted fields. It used to spread the raw request body into
// prisma.workspace.create, so a caller could send nested relation writes
// (e.g. `tasks: { connect: [{ id }] }`) and move another user's records into
// a workspace they own — where canAccess then grants them read/write.
//
// Like the other suites here, this runs against the dev database with
// throwaway fixtures that are removed in afterAll.
const prisma = require('../src/config/prisma');
const workspaceService = require('../src/services/workspace.service');
const taskService = require('../src/services/task.service');
const { makeUser, makeWorkspaceWithMembers, cleanupUsers } = require('./helpers/fixtures');

describe('workspace.create — mass assignment', () => {
  let victim, attacker, victimWorkspace, victimTask;

  beforeAll(async () => {
    victim = await makeUser('victim');
    attacker = await makeUser('attacker');
    victimWorkspace = await makeWorkspaceWithMembers(victim);
    victimTask = await taskService.create({ title: 'Victim task', workspaceId: victimWorkspace.id }, victim.id);
  });

  afterAll(async () => {
    await cleanupUsers(victim, attacker);
    await prisma.$disconnect();
  });

  test('ignores nested relation writes in the request body', async () => {
    const created = await workspaceService.create(
      {
        name: 'Attacker workspace',
        tasks: { connect: [{ id: victimTask.id }] },
        ownerId: victim.id,
      },
      attacker.id
    );

    expect(created.ownerId).toBe(attacker.id);

    const task = await prisma.task.findUnique({ where: { id: victimTask.id } });
    expect(task.workspaceId).toBe(victimWorkspace.id);
  });

  test('still applies the allowlisted fields', async () => {
    const created = await workspaceService.create({ name: 'Legit workspace', icon: '🚀' }, attacker.id);
    expect(created.name).toBe('Legit workspace');
    expect(created.icon).toBe('🚀');
  });
});
