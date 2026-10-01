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

describe('deleteAccount — Google-only accounts (no password)', () => {
  test('are refused without a matching email', async () => {
    const googleUser = await makeUser('deleteGoogleNoEmail'); // password: null
    await expect(userService.deleteAccount(googleUser.id, undefined, undefined)).rejects.toMatchObject({ statusCode: 400 });
    await expect(userService.deleteAccount(googleUser.id, undefined, 'someone-else@example.invalid')).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(await prisma.user.findUnique({ where: { id: googleUser.id } })).toBeTruthy();
    await cleanupUsers(googleUser);
  });

  test('are deleted when they type their own email (case- and whitespace-insensitive)', async () => {
    const googleUser = await makeUser('deleteGoogleOk');
    const typed = `  ${googleUser.email.toUpperCase()} `;
    await expect(userService.deleteAccount(googleUser.id, undefined, typed)).resolves.toEqual({ deleted: true });
    expect(await prisma.user.findUnique({ where: { id: googleUser.id } })).toBeNull();
  });

  test('an account WITH a password cannot bypass it by typing its email', async () => {
    const user = await makeUserWithPassword('deletePasswordBypass');
    await expect(userService.deleteAccount(user.id, undefined, user.email)).rejects.toMatchObject({ statusCode: 400 });
    await expect(userService.deleteAccount(user.id, 'wrong password 9', user.email)).rejects.toMatchObject({
      statusCode: 401,
    });
    expect(await prisma.user.findUnique({ where: { id: user.id } })).toBeTruthy();
    await cleanupUsers(user);
  });

  test('still refuses while the account owns a workspace with other members', async () => {
    const googleOwner = await makeUser('deleteGoogleOwner');
    const mate = await makeUser('deleteGoogleMate');
    await makeWorkspaceWithMembers(googleOwner, { editors: [mate] });
    await expect(userService.deleteAccount(googleOwner.id, undefined, googleOwner.email)).rejects.toThrow(/other members/i);
    await cleanupUsers(googleOwner, mate);
  });
});

describe('getProfile — hasPassword', () => {
  test('reports whether a password exists without ever returning the hash', async () => {
    const withPw = await makeUserWithPassword('profileWithPw');
    const without = await makeUser('profileNoPw');

    const a = await userService.getProfile(withPw.id);
    const b = await userService.getProfile(without.id);

    expect(a.hasPassword).toBe(true);
    expect(b.hasPassword).toBe(false);
    expect(a).not.toHaveProperty('password');
    expect(b).not.toHaveProperty('password');

    await cleanupUsers(withPw, without);
  });
});
