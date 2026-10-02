// Regression test for the Google login verified_email fix. `loginWithGoogle`
// destructured `verified_email` off the profile in a comment and never
// actually checked it — an account-linking flow that trusts an *unverified*
// Google email lets anyone who registers `victim@x.com` at Google without
// owning it get silently linked to, and logged into, the existing Clientglass
// account with that email.
//
// Mocks `global.fetch` (the only external dependency `loginWithGoogle` has)
// rather than hitting Google's real OAuth endpoints — everything else is
// the real Prisma/DB path, same convention as auth.test.js.
const prisma = require('../src/config/prisma');
const authService = require('../src/services/auth.service');
const { makeUser, cleanupUsers } = require('./helpers/fixtures');

function mockGoogleFetch({ verifiedEmail, email, id = 'fake-google-id' }) {
  return jest.spyOn(global, 'fetch').mockImplementation((url) => {
    if (String(url).includes('oauth2.googleapis.com/token')) {
      return Promise.resolve({ ok: true, json: async () => ({ access_token: 'fake-google-access-token' }) });
    }
    if (String(url).includes('googleapis.com/oauth2/v2/userinfo')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          id,
          email,
          name: 'Google Test User',
          picture: '',
          verified_email: verifiedEmail,
        }),
      });
    }
    throw new Error(`Unexpected fetch call in test: ${url}`);
  });
}

describe('auth.service.loginWithGoogle — verified_email', () => {
  let existingUser;

  afterEach(async () => {
    global.fetch.mockRestore?.();
    if (existingUser) await cleanupUsers(existingUser);
    existingUser = null;
  });

  test('rejects login when the Google profile email is unverified', async () => {
    const email = `test-google-unverified-${Date.now()}@example.invalid`;
    existingUser = await makeUser('google-target', { password: 'irrelevant-hash', email });

    mockGoogleFetch({ verifiedEmail: false, email });

    await expect(authService.loginWithGoogle('fake-code')).rejects.toMatchObject({
      statusCode: 401,
    });

    // And critically: the existing account must NOT have been linked.
    const reloaded = await prisma.user.findUnique({ where: { id: existingUser.id } });
    expect(reloaded.googleId).toBeNull();
  });

  test('accepts login and links the account when the email is verified', async () => {
    const email = `test-google-verified-${Date.now()}@example.invalid`;
    existingUser = await makeUser('google-target-2', { password: 'irrelevant-hash', email });

    mockGoogleFetch({ verifiedEmail: true, email });

    const { user } = await authService.loginWithGoogle('fake-code');
    expect(user.id).toBe(existingUser.id);
    expect(user.googleId).toBe('fake-google-id');
  });
});

// Account pre-hijacking: anyone can register `victim@gmail.com` with a password
// of their own choosing — nothing proves they own the address. When the real
// owner later signs in with Google, the accounts are linked by email; if the
// attacker's password survived the link, they keep a working login into the
// victim's account (and its data) forever. Linking must therefore drop the
// password and revoke any sessions the attacker already holds.
describe('auth.service.loginWithGoogle — account pre-hijacking', () => {
  const created = [];
  afterEach(async () => {
    global.fetch.mockRestore?.();
    await cleanupUsers(...created.splice(0));
  });

  test('linking to a password account removes that password and revokes existing sessions', async () => {
    const authService2 = require('../src/services/auth.service');
    const email = `prehijack-${Date.now()}@example.invalid`;
    const attacker = await authService2.register({ name: 'Attacker', email, password: 'attacker-password-1' });
    created.push(attacker.user);
    const attackerRefresh = attacker.refreshToken;
    expect(await authService2.login({ email, password: 'attacker-password-1' })).toBeTruthy();

    mockGoogleFetch({ verifiedEmail: true, email, id: `gid-prehijack-${Date.now()}` });
    const { user } = await authService2.loginWithGoogle('fake-code');
    expect(user.id).toBe(attacker.user.id);

    await expect(authService2.login({ email, password: 'attacker-password-1' })).rejects.toMatchObject({ statusCode: 401 });
    const row = await prisma.user.findUnique({ where: { id: user.id }, omit: { password: false } });
    expect(row.password).toBeNull();
    expect(row.tokenVersion).toBeGreaterThan(attacker.user.tokenVersion);
    // The refresh token the attacker already held no longer works.
    await expect(authService2.refresh(attackerRefresh, attacker.csrfToken)).rejects.toThrow(/revoked/i);
  });

  test('a dotted/plus-addressed Gmail maps to the existing normalized account, with no duplicate', async () => {
    const stamp = Date.now();
    const registered = await authService.register({ name: 'Dotty', email: `dotty${stamp}@gmail.com`, password: 'a-long-password-1' });
    created.push(registered.user);

    mockGoogleFetch({ verifiedEmail: true, email: `Dot.ty${stamp}@gmail.com`, id: `gid-dotty-${stamp}` });
    const { user } = await authService.loginWithGoogle('fake-code');
    expect(user.id).toBe(registered.user.id);
    expect(await prisma.user.count({ where: { email: { contains: `ty${stamp}@gmail.com` } } })).toBe(1);
  });

  test('a returning Google user is found by googleId and keeps working', async () => {
    const email = `returning-${Date.now()}@example.invalid`;
    mockGoogleFetch({ verifiedEmail: true, email, id: `gid-return-${Date.now()}` });
    const first = await authService.loginWithGoogle('fake-code');
    created.push(first.user);
    const second = await authService.loginWithGoogle('fake-code');
    expect(second.user.id).toBe(first.user.id);
  });
});
