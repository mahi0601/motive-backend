// Plans are priced by active client (a workspace with a live status link), and
// cap team size per workspace. The limits apply when something is ADDED: a free
// account that already has several live links keeps them, it just cannot turn
// on another.
const crypto = require('crypto');
const prisma = require('../src/config/prisma');
const workspaceService = require('../src/services/workspace.service');
const { makeUser, makeWorkspaceWithMembers, testEmail, cleanupUsers } = require('./helpers/fixtures');

const PAID = { isPro: true, plan: 'studio' };
const newWorkspace = (owner, n) => workspaceService.create({ name: `Client ${n} (${owner.id})` }, owner.id);
const share = (ws, user) => workspaceService.enableShare(ws.id, user.id);
const expect402 = async (promise, pattern) => {
  const err = await promise.then(() => null, (e) => e);
  expect(err).not.toBeNull();
  expect(err.statusCode).toBe(402);
  if (pattern) expect(err.message).toMatch(pattern);
};

describe('active-client limit (turning on a status link)', () => {
  const users = [];
  const make = async (label, overrides) => {
    const u = await makeUser(label, overrides);
    users.push(u);
    return u;
  };
  afterAll(async () => {
    await cleanupUsers(...users);
    await prisma.$disconnect();
  });

  test('a free account can run one client status page, and the second is refused with 402', async () => {
    const user = await make('free-clients');
    const [a, b] = [await newWorkspace(user, 1), await newWorkspace(user, 2)];
    await share(a, user);
    await expect402(share(b, user), /1 active client/i);
  });

  test('the message tells a free account what upgrading gives', async () => {
    const user = await make('free-msg');
    await share(await newWorkspace(user, 1), user);
    await expect402(share(await newWorkspace(user, 2), user), /Studio/);
  });

  test('regenerating the link of the one live page is still allowed', async () => {
    const user = await make('free-rotate');
    const a = await newWorkspace(user, 1);
    await share(a, user);
    await expect(share(a, user)).resolves.toEqual(expect.objectContaining({ token: expect.any(String) }));
  });

  test('turning a link off frees the slot', async () => {
    const user = await make('free-off');
    const [a, b] = [await newWorkspace(user, 1), await newWorkspace(user, 2)];
    await share(a, user);
    await expect402(share(b, user));
    await workspaceService.disableShare(a.id, user.id);
    await expect(share(b, user)).resolves.toBeDefined();
  });

  test("one account's links never count against another's", async () => {
    const [u1, u2] = [await make('free-iso-1'), await make('free-iso-2')];
    await share(await newWorkspace(u1, 1), u1);
    await expect(share(await newWorkspace(u2, 1), u2)).resolves.toBeDefined();
  });

  test('an account already over the limit keeps its links and can regenerate them, but cannot add another', async () => {
    const user = await make('free-grandfathered');
    const wss = [];
    for (let i = 0; i < 3; i++) {
      const ws = await newWorkspace(user, i);
      await prisma.workspace.update({
        where: { id: ws.id },
        data: { shareTokenHash: crypto.randomBytes(16).toString('hex'), shareEnabledAt: new Date() },
      });
      wss.push(ws);
    }
    await expect(share(wss[0], user)).resolves.toBeDefined();
    await expect402(share(await newWorkspace(user, 9), user));
  });

  test('Studio allows 10 active clients and refuses the 11th, pointing at Agency', async () => {
    const user = await make('studio-clients', PAID);
    for (let i = 0; i < 10; i++) await share(await newWorkspace(user, i), user);
    await expect402(share(await newWorkspace(user, 10), user), /Agency/);
  });

  test('Agency has no client limit', async () => {
    const user = await make('agency-clients', { isPro: true, plan: 'agency' });
    for (let i = 0; i < 12; i++) await share(await newWorkspace(user, i), user);
    expect(await prisma.workspace.count({ where: { ownerId: user.id, shareEnabledAt: { not: null } } })).toBe(12);
  });

  test('lifetime Pro keeps everything, even though its plan column says free', async () => {
    const user = await make('lifetime-clients', { isPro: true, proLifetime: true, plan: 'free' });
    for (let i = 0; i < 11; i++) await share(await newWorkspace(user, i), user);
  });

  test('a Pro account from before tiers existed (plan column untouched) is treated as Agency', async () => {
    const user = await make('legacy-pro-clients', { isPro: true });
    for (let i = 0; i < 11; i++) await share(await newWorkspace(user, i), user);
  });

  test('a lapsed subscriber falls back to the free limit', async () => {
    const user = await make('lapsed-clients', { isPro: false, plan: 'agency' });
    await share(await newWorkspace(user, 1), user);
    await expect402(share(await newWorkspace(user, 2), user));
  });
});

describe('team-size limit per workspace', () => {
  let studioOwner, agencyOwner, freeOwner, extras;
  beforeAll(async () => {
    studioOwner = await makeUser('seat-studio', PAID);
    agencyOwner = await makeUser('seat-agency', { isPro: true, plan: 'agency' });
    freeOwner = await makeUser('seat-free');
    extras = [];
    for (let i = 0; i < 6; i++) extras.push(await makeUser(`seat-extra-${i}`));
  });
  afterAll(async () => {
    await cleanupUsers(studioOwner, agencyOwner, freeOwner, ...extras);
  });
  const invite = (ws, owner) => workspaceService.createInvite(ws.id, owner.id, testEmail('seat'), 'editor');

  test('Studio: a workspace with owner plus 3 can still invite one more (5 seats)', async () => {
    const ws = await makeWorkspaceWithMembers(studioOwner, { editors: extras.slice(0, 3) });
    await expect(invite(ws, studioOwner)).resolves.toBeDefined();
  });

  test('Studio: owner plus 4 is full, and the message names the limit and the next plan', async () => {
    const ws = await makeWorkspaceWithMembers(studioOwner, { editors: extras.slice(0, 4) });
    await expect402(invite(ws, studioOwner), /5 members.*Agency/s);
  });

  test('Agency allows more than Studio does', async () => {
    const ws = await makeWorkspaceWithMembers(agencyOwner, { editors: extras });
    await expect(invite(ws, agencyOwner)).resolves.toBeDefined();
  });

  test('Free is still 2 seats', async () => {
    const ws = await makeWorkspaceWithMembers(freeOwner, { editors: extras.slice(0, 1) });
    await expect402(invite(ws, freeOwner), /2 members/);
  });

  test('accepting an invite re-checks the limit against the owner\'s plan', async () => {
    const ws = await makeWorkspaceWithMembers(studioOwner, { editors: extras.slice(0, 4) });
    const joiner = await makeUser('seat-joiner');
    try {
      const raw = crypto.randomBytes(32).toString('hex');
      await prisma.workspaceInvite.create({
        data: {
          workspaceId: ws.id,
          email: joiner.email.toLowerCase(),
          role: 'editor',
          tokenHash: crypto.createHash('sha256').update(raw).digest('hex'),
          invitedById: studioOwner.id,
          expiresAt: new Date(Date.now() + 86400000),
        },
      });
      await expect402(workspaceService.acceptInvite(raw, joiner.id, joiner.email), /member limit/i);
    } finally {
      await cleanupUsers(joiner);
    }
  });
});
