// Retention: old operational rows are pruned so the free-tier database stays
// small and personal data does not outlive its purpose. Each case plants a row
// just inside and just outside its window and checks only the stale one goes.
const prisma = require('../src/config/prisma');
const { runCleanup, start, stop } = require('../src/jobs/cleanup');
const { makeUser, makeWorkspaceWithMembers, cleanupUsers } = require('./helpers/fixtures');

const daysAgo = (d) => new Date(Date.now() - d * 86400000);

describe('cleanup job', () => {
  let user, ws;
  const tag = `cleanup-${Date.now()}`;
  beforeAll(async () => {
    user = await makeUser('cleanup');
    ws = await makeWorkspaceWithMembers(user);
  });
  afterAll(async () => {
    stop();
    await prisma.nativeExchangeCode.deleteMany({ where: { code: { startsWith: tag } } });
    await prisma.webhookEvent.deleteMany({ where: { stripeEventId: { startsWith: tag } } });
    await prisma.securityEvent.deleteMany({ where: { type: { startsWith: tag } } });
    await cleanupUsers(user);
    await prisma.$disconnect();
  });

  test('prunes each table by its own window and nothing newer', async () => {
    await prisma.nativeExchangeCode.createMany({
      data: [
        { code: `${tag}-old`, userId: user.id, codeChallenge: 'c', expiresAt: daysAgo(3) },
        { code: `${tag}-recent`, userId: user.id, codeChallenge: 'c', expiresAt: daysAgo(0.1) },
      ],
    });
    await prisma.webhookEvent.createMany({
      data: [
        { stripeEventId: `${tag}-old`, type: 't', createdAt: daysAgo(40) },
        { stripeEventId: `${tag}-new`, type: 't', createdAt: daysAgo(5) },
      ],
    });
    await prisma.securityEvent.createMany({
      data: [
        { type: `${tag}.old`, createdAt: daysAgo(200) },
        { type: `${tag}.new`, createdAt: daysAgo(20) },
      ],
    });
    const oldRead = await prisma.notification.create({ data: { userId: user.id, title: 't', message: 'm', read: true, createdAt: daysAgo(100) } });
    const oldUnread = await prisma.notification.create({ data: { userId: user.id, title: 't', message: 'm', read: false, createdAt: daysAgo(100) } });
    const newRead = await prisma.notification.create({ data: { userId: user.id, title: 't', message: 'm', read: true, createdAt: daysAgo(10) } });
    const oldLog = await prisma.activityLog.create({ data: { action: 'a', userId: user.id, timestamp: daysAgo(400) } });
    const newLog = await prisma.activityLog.create({ data: { action: 'a', userId: user.id, timestamp: daysAgo(30) } });
    const mk = (email, status, createdAt) =>
      prisma.workspaceInvite.create({ data: { workspaceId: ws.id, email, tokenHash: `${tag}-${email}`, status, invitedById: user.id, expiresAt: daysAgo(-7), createdAt, updatedAt: createdAt } });
    const invOldAccepted = await mk(`a-${tag}@x.test`, 'accepted', daysAgo(60));
    const invOldPending = await mk(`b-${tag}@x.test`, 'pending', daysAgo(60));
    const invNewDeclined = await mk(`c-${tag}@x.test`, 'declined', daysAgo(5));
    const sessOld = await prisma.session.create({ data: { userId: user.id, expiresAt: daysAgo(1) } });
    const sessRevokedOld = await prisma.session.create({ data: { userId: user.id, expiresAt: daysAgo(-20), revokedAt: daysAgo(10) } });
    const sessLive = await prisma.session.create({ data: { userId: user.id, expiresAt: daysAgo(-20) } });

    const counts = await runCleanup();

    const exists = async (model, where) => (await prisma[model].count({ where })) === 1;
    expect(await exists('nativeExchangeCode', { code: `${tag}-old` })).toBe(false);
    expect(await exists('nativeExchangeCode', { code: `${tag}-recent` })).toBe(true);
    expect(await exists('webhookEvent', { stripeEventId: `${tag}-old` })).toBe(false);
    expect(await exists('webhookEvent', { stripeEventId: `${tag}-new` })).toBe(true);
    expect(await exists('securityEvent', { type: `${tag}.old` })).toBe(false);
    expect(await exists('securityEvent', { type: `${tag}.new` })).toBe(true);
    expect(await exists('notification', { id: oldRead.id })).toBe(false);
    expect(await exists('notification', { id: oldUnread.id })).toBe(true); // unread is never pruned
    expect(await exists('notification', { id: newRead.id })).toBe(true);
    expect(await exists('activityLog', { id: oldLog.id })).toBe(false);
    expect(await exists('activityLog', { id: newLog.id })).toBe(true);
    expect(await exists('workspaceInvite', { id: invOldAccepted.id })).toBe(false);
    expect(await exists('workspaceInvite', { id: invOldPending.id })).toBe(true); // pending is live state
    expect(await exists('workspaceInvite', { id: invNewDeclined.id })).toBe(true);
    expect(await exists('session', { id: sessOld.id })).toBe(false);
    expect(await exists('session', { id: sessRevokedOld.id })).toBe(false);
    expect(await exists('session', { id: sessLive.id })).toBe(true);
    expect(counts.nativeExchangeCodes).toBeGreaterThanOrEqual(1);
  });

  test('start() runs once immediately, does not keep the process alive, and a failing run does not throw', async () => {
    const spy = jest.spyOn(prisma.nativeExchangeCode, 'deleteMany').mockRejectedValue(new Error('db down'));
    const timer = start({ intervalMs: 60_000 });
    expect(timer.hasRef()).toBe(false);
    await new Promise((r) => setTimeout(r, 100));
    spy.mockRestore();
    stop();
  });
});
