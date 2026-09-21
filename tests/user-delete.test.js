// Guards the fix for a real data-loss bug: Workspace.owner is
// onDelete: Cascade, so deleting the owner's account used to delete the
// whole workspace out from under every other member — silently, with no
// warning, and now a routine way to lose a team's data rather than a
// theoretical edge case, since inviting real teammates is the whole point
// of the invite lifecycle. See user.service.js#deleteAccount's own note.
const prisma = require('../src/config/prisma');
const userService = require('../src/services/user.service');
const { hashPassword } = require('../src/utils/password.util');
const { makeUser, makeWorkspaceWithMembers, cleanupUsers } = require('./helpers/fixtures');

const PASSWORD = 'correct horse battery staple 1';

async function makeUserWithPassword(label) {
  return makeUser(label, { password: await hashPassword(PASSWORD) });
}

describe('deleteAccount — owner-with-other-members guard', () => {
  test('is refused when the account owns a workspace that has other members', async () => {
    const owner = await makeUserWithPassword('deleteOwnerBlocked');
    const teammate = await makeUser('deleteTeammate');
    await makeWorkspaceWithMembers(owner, { editors: [teammate] });

    await expect(userService.deleteAccount(owner.id, PASSWORD)).rejects.toThrow(/other members/i);

    // and the account must still exist — a rejected delete is not a partial one
    const stillThere = await prisma.user.findUnique({ where: { id: owner.id } });
    expect(stillThere).toBeTruthy();

    await cleanupUsers(owner, teammate);
  });

  test('succeeds for an account that owns only solo workspaces', async () => {
    const solo = await makeUserWithPassword('deleteSolo');
    await makeWorkspaceWithMembers(solo); // owner only, no other members

    await expect(userService.deleteAccount(solo.id, PASSWORD)).resolves.toEqual({ deleted: true });
    const gone = await prisma.user.findUnique({ where: { id: solo.id } });
    expect(gone).toBeNull();
  });

  test('succeeds for an account that is only a member (not owner) of a shared workspace', async () => {
    const owner = await makeUser('deleteWsOwner');
    const member = await makeUserWithPassword('deleteMemberOnly');
    await makeWorkspaceWithMembers(owner, { editors: [member] });

    await expect(userService.deleteAccount(member.id, PASSWORD)).resolves.toEqual({ deleted: true });
    const gone = await prisma.user.findUnique({ where: { id: member.id } });
    expect(gone).toBeNull();

    // the workspace and its owner must be untouched by a member leaving
    const ownerStillThere = await prisma.user.findUnique({ where: { id: owner.id } });
    expect(ownerStillThere).toBeTruthy();

    await cleanupUsers(owner);
  });

  test('an incorrect password is still rejected before the membership check ever runs', async () => {
    const owner = await makeUserWithPassword('deleteWrongPassword');
    const teammate = await makeUser('deleteWrongPasswordMate');
    await makeWorkspaceWithMembers(owner, { editors: [teammate] });

    await expect(userService.deleteAccount(owner.id, 'not the right password')).rejects.toThrow();
    const stillThere = await prisma.user.findUnique({ where: { id: owner.id } });
    expect(stillThere).toBeTruthy();

    await cleanupUsers(owner, teammate);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });
});
