// Signing up with Google has no checkbox, so a brand-new Google account is marked
// `termsPending` and the app holds it on an "agree to continue" page until it agrees to
// the Terms and Privacy Policy (16 or older). Existing accounts are NOT forced: linking
// Google to one, or signing in again, changes nothing. Agreement is recorded with its
// time and version, only for a real boolean yes, and never rewritten once given.
const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/prisma');
const authService = require('../src/services/auth.service');
const { TERMS_VERSION } = require('../src/config/legal');
const { accessTokenFor, makeUser, testEmail, cleanupUsers } = require('./helpers/fixtures');

const mockGoogle = ({ email, id }) =>
  jest.spyOn(global, 'fetch').mockImplementation((url) => {
    if (String(url).includes('oauth2.googleapis.com/token')) return Promise.resolve({ ok: true, json: async () => ({ access_token: 'x' }) });
    if (String(url).includes('googleapis.com/oauth2/v2/userinfo')) {
      return Promise.resolve({ ok: true, json: async () => ({ id, email, name: 'Gina Google', picture: '', verified_email: true }) });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });

describe('terms for Google sign-ups', () => {
  const emails = [];
  const users = [];
  afterEach(() => global.fetch.mockRestore?.());
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { in: emails } } });
    await cleanupUsers(...users);
    await prisma.$disconnect();
  });
  const gid = () => `g-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const as = async (u) => ({ Authorization: `Bearer ${await accessTokenFor(u)}` });
  const accept = async (u, body) => request(app).post('/api/users/me/accept-terms').set(await as(u)).send(body);

  describe('who is asked', () => {
    test('a brand-new Google account is marked pending, with nothing recorded', async () => {
      const email = testEmail('gnew');
      emails.push(email.toLowerCase());
      mockGoogle({ email, id: gid() });
      await authService.loginWithGoogle('code');
      const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
      expect(user).toMatchObject({ termsPending: true, termsAcceptedAt: null, termsVersion: null });
    });

    test('an existing account that links Google is not forced to agree', async () => {
      const email = testEmail('glink');
      const existing = await makeUser('glink', { email, password: 'hash', emailVerifiedAt: new Date() });
      users.push(existing);
      mockGoogle({ email, id: gid() });
      await authService.loginWithGoogle('code');
      expect((await prisma.user.findUnique({ where: { id: existing.id } })).termsPending).toBe(false);
    });

    test('signing in with Google again leaves a pending account pending, and an agreed one agreed', async () => {
      const email = testEmail('gagain');
      emails.push(email.toLowerCase());
      const id = gid();
      mockGoogle({ email, id });
      await authService.loginWithGoogle('code');
      await authService.loginWithGoogle('code');
      const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
      expect(user.termsPending).toBe(true);
      await prisma.user.update({ where: { id: user.id }, data: { termsPending: false, termsAcceptedAt: new Date(), termsVersion: TERMS_VERSION } });
      await authService.loginWithGoogle('code');
      expect(await prisma.user.findUnique({ where: { id: user.id } })).toMatchObject({ termsPending: false, termsVersion: TERMS_VERSION });
    });

    test('a password sign-up is never pending', async () => {
      const email = testEmail('gpw');
      emails.push(email.toLowerCase());
      await authService.register({ name: 'P', email, password: 'correct-horse-1', acceptTerms: true });
      expect((await prisma.user.findUnique({ where: { email: email.toLowerCase() } })).termsPending).toBe(false);
    });

    test('the profile tells the app whether to ask', async () => {
      const pending = await makeUser('gprof', { termsPending: true });
      const fine = await makeUser('gprof2');
      users.push(pending, fine);
      const get = async (u) => (await request(app).get('/api/users/me').set(await as(u))).body;
      expect((await get(pending)).user.termsPending).toBe(true);
      expect((await get(fine)).user.termsPending).toBe(false);
    });
  });

  describe('POST /api/users/me/accept-terms', () => {
    test('records agreement with the time and version, and clears the pending flag', async () => {
      const u = await makeUser('gacc', { termsPending: true });
      users.push(u);
      const before = Date.now();
      const res = await accept(u, { acceptTerms: true });
      expect(res.status).toBe(200);
      const row = await prisma.user.findUnique({ where: { id: u.id } });
      expect(row).toMatchObject({ termsPending: false, termsVersion: TERMS_VERSION });
      expect(row.termsAcceptedAt.getTime()).toBeGreaterThanOrEqual(before - 2000);
    });

    test.each([['missing', {}], ['false', { acceptTerms: false }], ['the string "true"', { acceptTerms: 'true' }], ['1', { acceptTerms: 1 }], ['null', { acceptTerms: null }]])(
      'is refused with 422 when acceptTerms is %s, and nothing changes',
      async (_l, body) => {
        const u = await makeUser('gref', { termsPending: true });
        users.push(u);
        expect((await accept(u, body)).status).toBe(422);
        expect(await prisma.user.findUnique({ where: { id: u.id } })).toMatchObject({ termsPending: true, termsAcceptedAt: null });
      }
    );

    test('a client cannot choose the time or the version', async () => {
      const u = await makeUser('gfake', { termsPending: true });
      users.push(u);
      await accept(u, { acceptTerms: true, termsVersion: 'fake', termsAcceptedAt: '2000-01-01T00:00:00Z' });
      const row = await prisma.user.findUnique({ where: { id: u.id } });
      expect(row.termsVersion).toBe(TERMS_VERSION);
      expect(row.termsAcceptedAt.getFullYear()).toBeGreaterThan(2000);
    });

    test('agreeing again does not rewrite the original time', async () => {
      const u = await makeUser('gonce', { termsPending: true });
      users.push(u);
      await accept(u, { acceptTerms: true });
      const first = (await prisma.user.findUnique({ where: { id: u.id } })).termsAcceptedAt;
      await new Promise((r) => setTimeout(r, 30));
      expect((await accept(u, { acceptTerms: true })).status).toBe(200);
      expect((await prisma.user.findUnique({ where: { id: u.id } })).termsAcceptedAt.getTime()).toBe(first.getTime());
    });

    test('an older account can agree too, and it is recorded', async () => {
      const u = await makeUser('gold');
      users.push(u);
      expect((await accept(u, { acceptTerms: true })).status).toBe(200);
      expect((await prisma.user.findUnique({ where: { id: u.id } })).termsAcceptedAt).not.toBeNull();
    });

    test('needs a signed-in user', async () => {
      expect((await request(app).post('/api/users/me/accept-terms').send({ acceptTerms: true })).status).toBe(401);
    });

    test('only ever changes the caller\'s own account', async () => {
      const a = await makeUser('gown-a', { termsPending: true });
      const b = await makeUser('gown-b', { termsPending: true });
      users.push(a, b);
      await accept(a, { acceptTerms: true, id: b.id, userId: b.id });
      expect((await prisma.user.findUnique({ where: { id: b.id } })).termsPending).toBe(true);
    });

    test('is written to the audit trail, with no personal data', async () => {
      const u = await makeUser('gaud', { termsPending: true });
      users.push(u);
      await accept(u, { acceptTerms: true });
      const rows = await prisma.securityEvent.findMany({ where: { type: 'terms_accepted', actorId: u.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0].meta).toEqual({ version: TERMS_VERSION });
    });
  });
});
