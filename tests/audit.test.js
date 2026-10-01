// SecurityEvent: an append-only trail for incident response. These tests pin the
// properties that make it safe to keep — it never breaks the operation it
// describes, it stores ids and a truncated ip (never an email or a full ip), and
// it survives the deletion of the account it is about.
const prisma = require('../src/config/prisma');
const audit = require('../src/services/audit.service');
const authService = require('../src/services/auth.service');
const workspaceService = require('../src/services/workspace.service');
const userService = require('../src/services/user.service');
const { hashPassword } = require('../src/utils/password.util');
const { makeUser, makeWorkspaceWithMembers, cleanupUsers } = require('./helpers/fixtures');

const eventsFor = (where) => prisma.securityEvent.findMany({ where, orderBy: { createdAt: 'asc' } });

describe('audit.record', () => {
  const marker = `audit-${Date.now()}`;
  afterAll(async () => {
    await prisma.securityEvent.deleteMany({ where: { type: { startsWith: marker } } });
    await prisma.$disconnect();
  });

  test('stores type, ids and meta', async () => {
    await audit.record({ type: `${marker}.a`, actorId: 'u1', targetUserId: 'u2', workspaceId: 'w1', meta: { role: 'viewer' } });
    const [row] = await eventsFor({ type: `${marker}.a` });
    expect(row).toMatchObject({ actorId: 'u1', targetUserId: 'u2', workspaceId: 'w1', meta: { role: 'viewer' } });
  });

  test.each([
    ['203.0.113.77', '203.0.113.0/24'],
    ['::ffff:198.51.100.9', '198.51.100.0/24'],
    ['2001:db8:abcd:12:3456:789a:bcde:f012', '2001:db8:abcd::/48'],
    [undefined, null],
    ['not-an-ip', null],
  ])('truncates ip %s -> %s', (ip, expected) => {
    expect(audit.truncateIp(ip)).toBe(expected);
  });

  test('never throws, even when the write fails', async () => {
    const spy = jest.spyOn(prisma.securityEvent, 'create').mockRejectedValueOnce(new Error('db down'));
    await expect(audit.record({ type: `${marker}.b` })).resolves.toBeUndefined();
    spy.mockRestore();
  });

  test('drops anything in meta that looks like an email or a credential', async () => {
    await audit.record({ type: `${marker}.c`, meta: { email: 'a@b.test', token: 'abc', password: 'x', role: 'editor', note: 'mail me at x@y.test' } });
    const [row] = await eventsFor({ type: `${marker}.c` });
    expect(JSON.stringify(row.meta)).not.toMatch(/a@b\.test|x@y\.test|abc|"x"/);
    expect(row.meta.role).toBe('editor');
  });
});

describe('events written by real flows', () => {
  const made = [];
  afterEach(async () => {
    await cleanupUsers(...made.splice(0));
  });

  test('membership changes record who did what to whom, in which workspace', async () => {
    const owner = await makeUser('auditOwner');
    const member = await makeUser('auditMember');
    made.push(owner, member);
    const ws = await makeWorkspaceWithMembers(owner, { editors: [member] });

    await workspaceService.updateMemberRole(ws.id, member.id, 'viewer', owner.id);
    await workspaceService.removeMember(ws.id, member.id, owner.id);

    const rows = await eventsFor({ workspaceId: ws.id });
    expect(rows.map((r) => r.type)).toEqual(['role_changed', 'member_removed']);
    expect(rows[0]).toMatchObject({ actorId: owner.id, targetUserId: member.id, meta: { role: 'viewer' } });
  });

  test('ownership transfer and sharing changes are recorded', async () => {
    const owner = await makeUser('auditOwner2');
    const next = await makeUser('auditNext');
    made.push(owner, next);
    const ws = await makeWorkspaceWithMembers(owner, { editors: [next] });

    await workspaceService.enableShare(ws.id, owner.id);
    await workspaceService.disableShare(ws.id, owner.id);
    await workspaceService.transferOwnership(ws.id, next.id, owner.id);

    expect((await eventsFor({ workspaceId: ws.id })).map((r) => r.type)).toEqual(['share_link_enabled', 'share_link_disabled', 'ownership_transferred']);
  });

  test('sign-in, failed sign-in and logout-everywhere are recorded', async () => {
    const user = await makeUser('auditLogin', { password: await hashPassword('right-password-1') });
    made.push(user);
    const before = new Date();

    await authService.login({ email: user.email, password: 'right-password-1' });
    await expect(authService.login({ email: user.email, password: 'wrong' })).rejects.toThrow();
    await authService.revokeAll(user.id);

    const rows = (await eventsFor({ createdAt: { gte: before } })).filter((r) => r.actorId === user.id || r.targetUserId === user.id);
    expect(rows.map((r) => r.type)).toEqual(['login_success', 'login_failed', 'logout_all']);
    // a failed attempt must not store the email that was typed
    expect(JSON.stringify(rows)).not.toContain(user.email);
  });

  test('account deletion is recorded and the record survives the account', async () => {
    const user = await makeUser('auditDelete', { password: await hashPassword('right-password-1') });
    await userService.deleteAccount(user.id, 'right-password-1');

    const rows = await eventsFor({ type: 'account_deleted', targetUserId: user.id });
    expect(rows).toHaveLength(1);
    expect(await prisma.user.findUnique({ where: { id: user.id } })).toBeNull();
  });
});
