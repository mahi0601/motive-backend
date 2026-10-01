// Session-per-login with rotating refresh tokens.
//
// Properties under test (each one was broken or absent before):
//   - a reload can restore the session: refresh needs nothing the page loses on
//     reload (the old memory-only CSRF nonce is gone);
//   - logout revokes that session even right after a reload, and only that one;
//   - a stolen refresh token that is replayed after rotation kills the session;
//   - two tabs refreshing at once with the same cookie both succeed;
//   - a revoked session's ACCESS token stops working immediately, not at expiry;
//   - /auth/refresh and /auth/logout reject cross-site requests (custom header +
//     Origin allowlist) in place of the nonce.
const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/prisma');
const config = require('../src/config/env');
const authService = require('../src/services/auth.service');
const tokenService = require('../src/services/token.service');
const { verifyToken } = require('../src/utils/jwt.util');
const { makeUser, cleanupUsers } = require('./helpers/fixtures');

const sessionRow = (sid) => prisma.session.findUnique({ where: { id: sid } });
const ORIGIN = config.corsOrigins[0] || 'http://localhost:5173';

describe('sessions', () => {
  let user;
  beforeEach(async () => {
    user = await makeUser('sess');
  });
  afterEach(async () => {
    await cleanupUsers(user);
  });

  test('every login creates its own session; tokens carry sid, and gen/ver for refresh', async () => {
    const a = await tokenService.issueTokens(user);
    const b = await tokenService.issueTokens(user);
    const ra = verifyToken(a.refreshToken);
    const rb = verifyToken(b.refreshToken);
    expect(ra.sid).not.toBe(rb.sid);
    expect(ra).toMatchObject({ type: 'refresh', id: user.id, gen: 0, ver: 0 });
    expect(verifyToken(a.accessToken)).toMatchObject({ type: 'access', id: user.id, sid: ra.sid, ver: 0 });
    expect(a.csrfToken).toBeUndefined();
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(2);
  });

  test('refresh needs only the cookie value — no nonce a reload would have lost — and rotates the generation', async () => {
    const { refreshToken } = await tokenService.issueTokens(user);
    const out = await authService.refresh(refreshToken);
    const next = verifyToken(out.refreshToken);
    expect(next.gen).toBe(1);
    expect(next.sid).toBe(verifyToken(refreshToken).sid);
    expect((await sessionRow(next.sid)).gen).toBe(1);
  });

  test('replaying a rotated-out token after the grace window revokes the whole session', async () => {
    const { refreshToken } = await tokenService.issueTokens(user);
    const sid = verifyToken(refreshToken).sid;
    const second = await authService.refresh(refreshToken); // gen 0 -> 1
    await prisma.session.update({ where: { id: sid }, data: { prevGenValidUntil: new Date(Date.now() - 1000) } });

    await expect(authService.refresh(refreshToken)).rejects.toMatchObject({ statusCode: 401 }); // the thief's replay
    expect((await sessionRow(sid)).revokedAt).toBeTruthy();
    await expect(authService.refresh(second.refreshToken)).rejects.toMatchObject({ statusCode: 401 }); // …and the legit holder is out too
  });

  test('two tabs refreshing with the same cookie at once both succeed (grace window)', async () => {
    const { refreshToken } = await tokenService.issueTokens(user);
    const [one, two] = await Promise.all([authService.refresh(refreshToken), authService.refresh(refreshToken)]);
    expect(one.accessToken).toBeTruthy();
    expect(two.accessToken).toBeTruthy();
    const sid = verifyToken(refreshToken).sid;
    const row = await sessionRow(sid);
    expect(row.revokedAt).toBeNull();
    expect(row.gen).toBe(1); // rotated once, the loser was answered with the current generation
    // whichever token a tab ends up holding keeps working
    await expect(authService.refresh(one.refreshToken)).resolves.toBeDefined();
    await expect(authService.refresh(two.refreshToken)).resolves.toBeDefined();
  });

  test('logout revokes that session only, with nothing but the cookie', async () => {
    const mine = await tokenService.issueTokens(user);
    const other = await tokenService.issueTokens(user);
    await authService.logout(mine.refreshToken);

    await expect(authService.refresh(mine.refreshToken)).rejects.toMatchObject({ statusCode: 401 });
    await expect(authService.refresh(other.refreshToken)).resolves.toBeDefined();
  });

  test('logout-everywhere revokes every session and bumps the version', async () => {
    const a = await tokenService.issueTokens(user);
    const b = await tokenService.issueTokens(user);
    await authService.revokeAll(user.id);
    await expect(authService.refresh(a.refreshToken)).rejects.toThrow();
    await expect(authService.refresh(b.refreshToken)).rejects.toThrow();
    expect((await prisma.user.findUnique({ where: { id: user.id } })).tokenVersion).toBe(1);
  });

  test('an expired session cannot refresh', async () => {
    const { refreshToken } = await tokenService.issueTokens(user);
    await prisma.session.update({ where: { id: verifyToken(refreshToken).sid }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(authService.refresh(refreshToken)).rejects.toMatchObject({ statusCode: 401 });
  });

  describe('access tokens are tied to a live session', () => {
    const get = (token) => request(app).get('/api/tasks').set('Authorization', `Bearer ${token}`);

    test('valid while the session lives, rejected the moment it is revoked', async () => {
      const { accessToken, refreshToken } = await tokenService.issueTokens(user);
      expect((await get(accessToken)).status).toBe(200);
      await authService.logout(refreshToken);
      expect((await get(accessToken)).status).toBe(401);
    });

    test('rejected after logout-everywhere even though the token has not expired', async () => {
      const { accessToken } = await tokenService.issueTokens(user);
      await authService.revokeAll(user.id);
      expect((await get(accessToken)).status).toBe(401);
    });

    test('a token without a session id (issued before this change) is rejected', async () => {
      const jwt = require('jsonwebtoken');
      const legacy = jwt.sign({ id: user.id, type: 'access' }, config.jwt.secret, { expiresIn: '5m' });
      expect((await get(legacy)).status).toBe(401);
    });
  });

  describe('cross-site protection on /auth/refresh and /auth/logout (replaces the CSRF nonce)', () => {
    const cookie = (t) => `${config.cookie.name}=${t}`;

    test('refresh works for a same-site request with the custom header', async () => {
      const { refreshToken } = await tokenService.issueTokens(user);
      const res = await request(app).post('/api/auth/refresh').set('Cookie', cookie(refreshToken)).set('Origin', ORIGIN).set('X-Requested-With', 'motive');
      expect(res.status).toBe(200);
      expect(res.body.accessToken).toBeTruthy();
      expect(res.body.csrfToken).toBeUndefined();
    });

    test('refresh is refused without the custom header (a plain cross-site form post cannot add it)', async () => {
      const { refreshToken } = await tokenService.issueTokens(user);
      const res = await request(app).post('/api/auth/refresh').set('Cookie', cookie(refreshToken)).set('Origin', ORIGIN);
      expect(res.status).toBe(403);
    });

    test('refresh is refused from an origin that is not allowed, even with the header', async () => {
      const { refreshToken } = await tokenService.issueTokens(user);
      const res = await request(app).post('/api/auth/refresh').set('Cookie', cookie(refreshToken)).set('Origin', 'https://evil.example').set('X-Requested-With', 'motive');
      expect(res.status).toBe(403);
    });

    test('logout is subject to the same checks, and a refused logout revokes nothing', async () => {
      const { refreshToken } = await tokenService.issueTokens(user);
      const bad = await request(app).post('/api/auth/logout').set('Cookie', cookie(refreshToken)).set('Origin', 'https://evil.example').set('X-Requested-With', 'motive');
      expect(bad.status).toBe(403);
      expect((await sessionRow(verifyToken(refreshToken).sid)).revokedAt).toBeNull();

      const good = await request(app).post('/api/auth/logout').set('Cookie', cookie(refreshToken)).set('Origin', ORIGIN).set('X-Requested-With', 'motive');
      expect(good.status).toBe(200);
      expect((await sessionRow(verifyToken(refreshToken).sid)).revokedAt).toBeTruthy();
    });
  });
});
