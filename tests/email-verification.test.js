// Email verification: proof that an account controls its address. Sign-in is
// never blocked on it. It gates what is abusable from a throwaway account
// (sending invites) and decides whether linking Google may keep a password.
const mockSend = jest.fn().mockResolvedValue(undefined);
jest.mock('../src/services/email.service', () => ({ sendEmail: (...a) => mockSend(...a) }));

const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/prisma');
const authService = require('../src/services/auth.service');
const workspaceService = require('../src/services/workspace.service');
const { signVerifyToken, signResetToken } = require('../src/utils/jwt.util');
const { accessTokenFor, makeUser, makeWorkspaceWithMembers, cleanupUsers, testEmail } = require('./helpers/fixtures');

const verifiedAt = async (id) => (await prisma.user.findUnique({ where: { id } })).emailVerifiedAt;
const linkIn = (call) => /verify-email\?token=([^"&\s]+)/.exec(call[0].html)?.[1];

describe('email verification', () => {
  const users = [];
  beforeEach(() => mockSend.mockClear());
  afterEach(async () => {
    await cleanupUsers(...users.splice(0));
  });
  const track = (u) => {
    users.push(u);
    return u;
  };

  test('registering sends one verification email and leaves the account unverified (sign-in still works)', async () => {
    const email = testEmail('reg');
    const { user, accessToken } = await authService.register({ name: 'R', email, password: 'correct-horse-1' });
    track(user);
    expect(accessToken).toBeTruthy();
    expect(await verifiedAt(user.id)).toBeNull();
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0]).toMatchObject({ to: email });
    expect(linkIn(mockSend.mock.calls[0])).toBeTruthy();
    await expect(authService.login({ email, password: 'correct-horse-1' })).resolves.toBeDefined();
  });

  test('the emailed link verifies the account, and using it twice is harmless', async () => {
    const { user } = await authService.register({ name: 'R', email: testEmail('link'), password: 'correct-horse-1' });
    track(user);
    const token = decodeURIComponent(linkIn(mockSend.mock.calls[0]));
    await authService.verifyEmail(token);
    const first = await verifiedAt(user.id);
    expect(first).toBeTruthy();
    await authService.verifyEmail(token);
    expect((await verifiedAt(user.id)).getTime()).toBe(first.getTime());
  });

  test('a token for a different purpose, an expired one, or one for another address is refused', async () => {
    const user = track(await makeUser('badtok', { emailVerifiedAt: null }));
    await expect(authService.verifyEmail(signResetToken(user.id, 0))).rejects.toMatchObject({ statusCode: 400 });
    await expect(authService.verifyEmail('garbage')).rejects.toMatchObject({ statusCode: 400 });
    await expect(authService.verifyEmail(signVerifyToken(user.id, 'someone-else@example.invalid'))).rejects.toMatchObject({ statusCode: 400 });
    expect(await verifiedAt(user.id)).toBeNull();
  });

  test('resend sends a fresh link to an unverified account and nothing to a verified one', async () => {
    const unverified = track(await makeUser('resend', { emailVerifiedAt: null }));
    const verified = track(await makeUser('resend2'));
    await authService.resendVerification(unverified.id);
    expect(mockSend).toHaveBeenCalledTimes(1);
    await authService.resendVerification(verified.id);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  test('resend over HTTP is rate limited per account', async () => {
    const u = track(await makeUser('resendHttp', { emailVerifiedAt: null }));
    const auth = { Authorization: `Bearer ${await accessTokenFor(u)}` };
    const codes = [];
    for (let i = 0; i < 5; i += 1) codes.push((await request(app).post('/api/auth/resend-verification').set(auth)).status);
    expect(codes.slice(0, 3)).toEqual([200, 200, 200]);
    expect(codes.slice(3)).toEqual([429, 429]);
  });

  test('POST /api/auth/verify-email verifies via the token in the body', async () => {
    const u = track(await makeUser('httpVerify', { emailVerifiedAt: null }));
    const res = await request(app).post('/api/auth/verify-email').send({ token: signVerifyToken(u.id, u.email) });
    expect(res.status).toBe(200);
    expect(await verifiedAt(u.id)).toBeTruthy();
  });

  describe('other ways an address is proven', () => {
    test('completing a password reset verifies the address (the link went to that inbox)', async () => {
      const u = track(await makeUser('reset', { emailVerifiedAt: null }));
      await authService.resetPassword(signResetToken(u.id, u.tokenVersion), 'a-new-password-1');
      expect(await verifiedAt(u.id)).toBeTruthy();
    });

    test('accepting an invite sent to the address verifies it', async () => {
      const owner = track(await makeUser('invOwner'));
      const ws = await makeWorkspaceWithMembers(owner);
      const invitee = track(await makeUser('invitee', { emailVerifiedAt: null }));
      await workspaceService.createInvite(ws.id, owner.id, invitee.email, 'editor');
      const raw = /invite\/([a-f0-9]+)/.exec(mockSend.mock.calls.at(-1)[0].html)[1];
      await workspaceService.acceptInvite(raw, invitee.id, invitee.email);
      expect(await verifiedAt(invitee.id)).toBeTruthy();
    });
  });

  describe('invites are gated and bounded', () => {
    test('an unverified account cannot send invites', async () => {
      const u = track(await makeUser('unverifiedOwner', { emailVerifiedAt: null }));
      const ws = await makeWorkspaceWithMembers(u);
      await expect(workspaceService.createInvite(ws.id, u.id, testEmail('x'), 'editor')).rejects.toMatchObject({ statusCode: 403, message: expect.stringMatching(/verify your email/i) });
      expect(mockSend).not.toHaveBeenCalled();
    });

    test('pending invites count toward the free member limit', async () => {
      const owner = track(await makeUser('limitOwner')); // free: 2 members, the owner is one
      const ws = await makeWorkspaceWithMembers(owner);
      await workspaceService.createInvite(ws.id, owner.id, testEmail('a'), 'editor'); // 1 member + 1 pending = 2
      await expect(workspaceService.createInvite(ws.id, owner.id, testEmail('b'), 'editor')).rejects.toMatchObject({ statusCode: 402 });
    });

    test('re-inviting the same address does not count twice', async () => {
      const owner = track(await makeUser('reinviteOwner'));
      const ws = await makeWorkspaceWithMembers(owner);
      const email = testEmail('same');
      await workspaceService.createInvite(ws.id, owner.id, email, 'editor');
      await expect(workspaceService.createInvite(ws.id, owner.id, email, 'viewer')).resolves.toBeDefined();
    });

    test('the limit is checked again when an invite is accepted', async () => {
      const owner = track(await makeUser('acceptLimitOwner', { isPro: true }));
      const ws = await makeWorkspaceWithMembers(owner);
      const invitees = [];
      for (const label of ['i1', 'i2', 'i3']) {
        const u = track(await makeUser(label));
        invitees.push(u);
        await workspaceService.createInvite(ws.id, owner.id, u.email, 'editor');
      }
      const raws = mockSend.mock.calls.map((c) => /invite\/([a-f0-9]+)/.exec(c[0].html)[1]);
      // The owner's Pro lapses before anyone accepts.
      await prisma.user.update({ where: { id: owner.id }, data: { isPro: false, proLifetime: false } });
      await workspaceService.acceptInvite(raws[0], invitees[0].id, invitees[0].email); // owner + 1 = 2: allowed
      await expect(workspaceService.acceptInvite(raws[1], invitees[1].id, invitees[1].email)).rejects.toMatchObject({ statusCode: 402 });
    });

    test('an account can only send a bounded number of invites per day', async () => {
      const owner = track(await makeUser('dailyOwner', { isPro: true }));
      const ws = await makeWorkspaceWithMembers(owner);
      await prisma.workspaceInvite.createMany({
        data: Array.from({ length: 20 }, (_, i) => ({
          workspaceId: ws.id, email: `bulk${i}-${Date.now()}@example.invalid`, tokenHash: `bulk-${Date.now()}-${i}`,
          status: 'pending', invitedById: owner.id, expiresAt: new Date(Date.now() + 86400000),
        })),
      });
      await expect(workspaceService.createInvite(ws.id, owner.id, testEmail('21st'), 'editor')).rejects.toMatchObject({ statusCode: 429 });
    });
  });

  describe('Google linking', () => {
    const googleFetch = (email, id) =>
      jest.spyOn(global, 'fetch').mockImplementation((url) => {
        if (String(url).includes('oauth2.googleapis.com/token')) return Promise.resolve({ ok: true, json: async () => ({ access_token: 't' }) });
        return Promise.resolve({ ok: true, json: async () => ({ id, email, name: 'G', picture: '', verified_email: true }) });
      });
    afterEach(() => global.fetch.mockRestore?.());

    test('a first-time Google sign-in marks the account verified', async () => {
      const email = testEmail('gnew');
      googleFetch(email, `gid-ver-${Date.now()}`);
      const { user } = await authService.loginWithGoogle('code');
      track(user);
      expect(await verifiedAt(user.id)).toBeTruthy();
    });

    test('linking to an UNVERIFIED password account removes the password (it may belong to someone else)', async () => {
      const email = testEmail('glink1');
      const { user } = await authService.register({ name: 'A', email, password: 'attacker-password-1' });
      track(user);
      googleFetch(email, `gid-l1-${Date.now()}`);
      await authService.loginWithGoogle('code');
      expect((await prisma.user.findUnique({ where: { id: user.id }, omit: { password: false } })).password).toBeNull();
    });

    test('linking to a VERIFIED password account keeps the password and the existing sessions', async () => {
      const email = testEmail('glink2');
      const { user, refreshToken } = await authService.register({ name: 'V', email, password: 'my-own-password-1' });
      track(user);
      await prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
      googleFetch(email, `gid-l2-${Date.now()}`);
      await authService.loginWithGoogle('code');
      const row = await prisma.user.findUnique({ where: { id: user.id }, omit: { password: false } });
      expect(row.password).toBeTruthy();
      expect(row.googleId).toBeTruthy();
      await expect(authService.refresh(refreshToken)).resolves.toBeDefined();
    });
  });
});
