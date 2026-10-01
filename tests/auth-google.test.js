// Regression test for the Google login verified_email fix. `loginWithGoogle`
// destructured `verified_email` off the profile in a comment and never
// actually checked it — an account-linking flow that trusts an *unverified*
// Google email lets anyone who registers `victim@x.com` at Google without
// owning it get silently linked to, and logged into, the existing Motive
// account with that email.
//
// Mocks `global.fetch` (the only external dependency `loginWithGoogle` has)
// rather than hitting Google's real OAuth endpoints — everything else is
// the real Prisma/DB path, same convention as auth.test.js.
const prisma = require('../src/config/prisma');
const authService = require('../src/services/auth.service');
const { makeUser, cleanupUsers } = require('./helpers/fixtures');

function mockGoogleFetch({ verifiedEmail, email }) {
  return jest.spyOn(global, 'fetch').mockImplementation((url) => {
    if (String(url).includes('oauth2.googleapis.com/token')) {
      return Promise.resolve({ ok: true, json: async () => ({ access_token: 'fake-google-access-token' }) });
    }
    if (String(url).includes('googleapis.com/oauth2/v2/userinfo')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          id: 'fake-google-id',
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
