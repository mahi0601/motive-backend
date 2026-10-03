// Signing up with a password needs an explicit "I am 16 or older and agree to the
// Terms and Privacy Policy". The server records when, and which version, so there
// is evidence of consent. Existing accounts are not forced to accept anything, and
// service-level callers (tests, scripts) that register without the flag still work.
const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/prisma');
const authService = require('../src/services/auth.service');
const userService = require('../src/services/user.service');
const { TERMS_VERSION } = require('../src/config/legal');
const { testEmail, makeUser, cleanupUsers } = require('./helpers/fixtures');

describe('terms acceptance at sign-up', () => {
  const emails = [];
  const users = [];
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { in: emails } } });
    await cleanupUsers(...users);
    await prisma.$disconnect();
  });

  const register = (extra = {}) => {
    const email = testEmail('terms');
    emails.push(email.toLowerCase());
    return { email, req: request(app).post('/api/auth/register').send({ name: 'Ada', email, password: 'correct-horse-1', ...extra }) };
  };

  test.each([
    ['is missing', {}],
    ['is false', { acceptTerms: false }],
    ['is the string "true", not a real yes', { acceptTerms: 'true' }],
    ['is 1', { acceptTerms: 1 }],
    ['is null', { acceptTerms: null }],
  ])('registering is refused with 422 when acceptTerms %s, and no account is made', async (_label, extra) => {
    const { email, req } = register(extra);
    const res = await req;
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/16 or older.*terms/i);
    expect(await prisma.user.count({ where: { email: email.toLowerCase() } })).toBe(0);
  });

  test('with acceptTerms true the account is created and the acceptance is recorded with its version', async () => {
    const { email, req } = register({ acceptTerms: true });
    const before = Date.now();
    const res = await req;
    expect(res.status).toBe(201);
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    expect(user.termsVersion).toBe(TERMS_VERSION);
    expect(user.termsAcceptedAt.getTime()).toBeGreaterThanOrEqual(before - 2000);
    expect(user.termsAcceptedAt.getTime()).toBeLessThanOrEqual(Date.now() + 2000);
  });

  test('a client cannot choose the version or the time: only the yes counts', async () => {
    const { email, req } = register({ acceptTerms: true, termsVersion: 'fake', termsAcceptedAt: '2000-01-01T00:00:00Z' });
    expect((await req).status).toBe(201);
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    expect(user.termsVersion).toBe(TERMS_VERSION);
    expect(user.termsAcceptedAt.getFullYear()).toBeGreaterThan(2000);
  });

  test('the service alone still registers without the flag, and records nothing', async () => {
    const email = testEmail('terms-service');
    emails.push(email.toLowerCase());
    await authService.register({ name: 'Svc', email, password: 'correct-horse-1' });
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    expect(user.termsAcceptedAt).toBeNull();
    expect(user.termsVersion).toBeNull();
  });

  test('existing accounts keep working and are not forced to accept', async () => {
    const old = await makeUser('terms-old');
    users.push(old);
    expect(old.termsAcceptedAt).toBeNull();
  });

  test('the acceptance is part of the data export, so a person can see what is held', async () => {
    const { email, req } = register({ acceptTerms: true });
    await req;
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    const exported = await userService.exportData(user.id);
    expect(exported.profile.termsVersion).toBe(TERMS_VERSION);
    expect(new Date(exported.profile.termsAcceptedAt).getTime()).toBe(user.termsAcceptedAt.getTime());
  });
});
