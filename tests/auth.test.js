// Regression coverage for the app's actual security boundary — register/
// login/refresh/logout and the tokenVersion-based revocation that makes
// "log out everywhere" and password-reset invalidation actually work. None
// of this was under test before (see PLAN's regression-debt list, item 2).
// Real Prisma, real jsonwebtoken signing — no mocking needed, since nothing
// here calls an external service.
const prisma = require('../src/config/prisma');
const authService = require('../src/services/auth.service');
const { issueTokens } = require('../src/services/token.service');
const { verifyToken, signResetToken } = require('../src/utils/jwt.util');
const { hashPassword } = require('../src/utils/password.util');
const { makeUser, cleanupUsers } = require('./helpers/fixtures');

describe('auth.service', () => {
  let user;

  afterEach(async () => {
    if (user) await cleanupUsers(user);
    user = null;
  });

  test('register creates a user and issues a working token pair', async () => {
    const email = `test-register-${Date.now()}@example.invalid`;
    const { user: created, accessToken, refreshToken } = await authService.register({
      name: 'Register Test',
      email,
      password: 'correcthorsebattery1',
    });
    user = created;

    expect(created.email).toBe(email);
    expect(verifyToken(accessToken)).toMatchObject({ id: created.id, type: 'access' });
    expect(verifyToken(refreshToken)).toMatchObject({ id: created.id, type: 'refresh', ver: 0 });
  });

  test('register rejects a duplicate email', async () => {
    user = await makeUser('dup', { password: 'irrelevant-hash' });
    await expect(
      authService.register({ name: 'Someone else', email: user.email, password: 'whatever12' })
    ).rejects.toThrow();
  });

  test('login rejects a wrong password', async () => {
    user = await makeUser('login', { password: await hashPassword('correct-password-1') });
    await expect(authService.login({ email: user.email, password: 'wrong-password' })).rejects.toThrow();
  });

  test('login succeeds with the right password and never leaks the hash', async () => {
    user = await makeUser('login2', { password: await hashPassword('correct-password-1') });
    const { user: loggedIn } = await authService.login({ email: user.email, password: 'correct-password-1' });
    expect(loggedIn.password).toBeUndefined();
  });

  test('login rejects a Google-only account (no password set) instead of throwing on a null hash', async () => {
    user = await makeUser('google-only', { password: null, googleId: 'fake-google-id' });
    await expect(authService.login({ email: user.email, password: 'anything' })).rejects.toThrow();
  });

  test('refresh rotates the pair for a valid, current-version token', async () => {
    user = await makeUser('refresh');
    const issued = issueTokens(user);
    const { accessToken, refreshToken: newRefresh } = await authService.refresh(issued.refreshToken);
    expect(verifyToken(accessToken)).toMatchObject({ id: user.id, type: 'access' });
    expect(verifyToken(newRefresh)).toMatchObject({ id: user.id, type: 'refresh', ver: 0 });
  });

  test('refresh rejects a token whose tokenVersion no longer matches (revoked)', async () => {
    user = await makeUser('revoke');
    const { refreshToken } = issueTokens(user); // ver: 0, matching the fresh user's tokenVersion

    // Simulates "logged out everywhere" / a password change elsewhere.
    await authService.revokeAll(user.id);

    await expect(authService.refresh(refreshToken)).rejects.toThrow();
  });

  test('logout is a no-op on a missing/invalid cookie — never throws', async () => {
    await expect(authService.logout(undefined)).resolves.toBeUndefined();
    await expect(authService.logout('not-a-real-jwt')).resolves.toBeUndefined();
  });

  test('logout revokes the session — a refresh token issued before logout is rejected after', async () => {
    user = await makeUser('logout');
    const { refreshToken } = issueTokens(user);

    await authService.logout(refreshToken);

    await expect(authService.refresh(refreshToken)).rejects.toThrow();
    const reloaded = await prisma.user.findUnique({ where: { id: user.id } });
    expect(reloaded.tokenVersion).toBe(1);
  });

  test('resetPassword\'s token is single-use via the same tokenVersion bump refresh/logout rely on', async () => {
    user = await makeUser('reset');
    const resetToken = signResetToken(user.id, user.tokenVersion); // ver: 0

    await authService.resetPassword(resetToken, 'a-brand-new-password-1');

    // The same token, replayed, must now fail — resetPassword bumps
    // tokenVersion as part of resetting, so a captured/leaked reset link
    // can't be used twice, and every other outstanding session is
    // invalidated by the same side effect (this is the "also signs you out
    // everywhere else" behavior the frontend's copy already promises).
    await expect(authService.resetPassword(resetToken, 'yet-another-password-1')).rejects.toThrow();
  });
});
