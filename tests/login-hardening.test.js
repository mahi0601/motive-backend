// Login must not tell an attacker which emails have accounts, neither by what it
// says nor by how long it takes, and one account must not be guessable at from
// many addresses. (Its own file: the per-account limiter keeps state per module.)
const request = require('supertest');
const app = require('../src/app');
// Wraps the real comparePassword in a jest.fn so calls can be counted while it still does real work.
jest.mock('../src/utils/password.util', () => {
  const actual = jest.requireActual('../src/utils/password.util');
  return { ...actual, comparePassword: jest.fn(actual.comparePassword) };
});
const { comparePassword } = require('../src/utils/password.util');
const authService = require('../src/services/auth.service');
const { hashPassword } = require('../src/utils/password.util');
const { makeUser, cleanupUsers, testEmail } = require('./helpers/fixtures');

describe('login timing', () => {
  let real, googleOnly;
  beforeAll(async () => {
    real = await makeUser('ltReal', { password: await hashPassword('right-password-1') });
    googleOnly = await makeUser('ltGoogle', { password: null, googleId: `gid-lt-${Date.now()}` });
  });
  afterAll(async () => cleanupUsers(real, googleOnly));
  beforeEach(() => comparePassword.mockClear());

  test.each([
    ['an unknown email', () => testEmail('nobody'), 'whatever-1'],
    ['a Google-only account (no password)', () => googleOnly.email, 'whatever-1'],
  ])('%s still costs one full password comparison, like a real account', async (_label, email, pw) => {
    await expect(authService.login({ email: email(), password: pw })).rejects.toMatchObject({ statusCode: 401 });
    expect(comparePassword).toHaveBeenCalledTimes(1);
  });

  test('a real account with a wrong password does the same single comparison and gives the same error', async () => {
    const err = await authService.login({ email: real.email, password: 'wrong-pass-1' }).catch((e) => e);
    expect(comparePassword).toHaveBeenCalledTimes(1);
    const unknown = await authService.login({ email: testEmail('nobody2'), password: 'wrong-pass-1' }).catch((e) => e);
    expect([err.statusCode, err.message]).toEqual([unknown.statusCode, unknown.message]);
  });

  test('the dummy comparison never makes an unknown email succeed, even with the dummy\'s own "password"', async () => {
    await expect(authService.login({ email: testEmail('nobody3'), password: '' })).rejects.toMatchObject({ statusCode: 401 });
    await expect(authService.login({ email: testEmail('nobody4'), password: 'dummy' })).rejects.toMatchObject({ statusCode: 401 });
  });
});

describe('per-account login limit', () => {
  const login = (email, password = 'wrong-pass-1') =>
    request(app).post('/api/auth/login').send({ email, password });

  test('the 11th attempt on one account in a window is refused, whatever the password', async () => {
    const email = testEmail('limited');
    const codes = [];
    for (let i = 0; i < 11; i += 1) codes.push((await login(email)).status);
    expect(codes.slice(0, 10)).toEqual(Array(10).fill(401));
    expect(codes[10]).toBe(429);
  });

  test('it is per account: another email is unaffected', async () => {
    expect((await login(testEmail('other'))).status).toBe(401);
  });

  test('capitalisation does not get around it', async () => {
    const base = testEmail('casing');
    for (let i = 0; i < 10; i += 1) await login(i % 2 ? base.toUpperCase() : base);
    expect((await login(base)).status).toBe(429);
  });

  test('the refusal does not reveal whether the account exists', async () => {
    const email = testEmail('hidden');
    for (let i = 0; i < 10; i += 1) await login(email);
    const res = await login(email);
    expect(res.status).toBe(429);
    expect(JSON.stringify(res.body)).not.toMatch(/exist|registered|no account/i);
  });
});
