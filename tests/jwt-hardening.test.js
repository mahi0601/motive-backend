// Token verification is strict about WHO issued a token and HOW it was signed,
// not only that the signature matches the secret:
//  - the algorithm is pinned to HS256 (the "alg" header is attacker-controlled,
//    so accepting whatever it says is how "alg: none" attacks work);
//  - tokens must carry this API's issuer and audience, so a token minted for a
//    different service that happens to share a secret is not accepted;
//  - refresh tokens use their own secret when JWT_REFRESH_SECRET is set, so a
//    leak of one signing key does not forge the other kind of token;
//  - outside development and test, a short signing secret refuses to boot.
const jwt = require('jsonwebtoken');
const { spawnSync } = require('child_process');
const path = require('path');
const config = require('../src/config/env');
const { signAccessToken, signRefreshToken, verifyToken } = require('../src/utils/jwt.util');

const claims = { id: 'u1', type: 'access', sid: 's1', ver: 0 };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

describe('algorithm, issuer and audience', () => {
  test('a token this API signs verifies and carries iss and aud', () => {
    const decoded = verifyToken(signAccessToken('u1', { sid: 's1', ver: 0 }));
    expect(decoded).toMatchObject({ id: 'u1', type: 'access', iss: config.jwt.issuer, aud: config.jwt.audience });
  });

  test('"alg: none" (no signature at all) is rejected', () => {
    const forged = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ ...claims, iss: config.jwt.issuer, aud: config.jwt.audience })}.`;
    expect(() => verifyToken(forged)).toThrow();
  });

  test('a token signed with a different HMAC algorithm (HS512) is rejected even with the right secret', () => {
    const t = jwt.sign(claims, config.jwt.secret, { algorithm: 'HS512', issuer: config.jwt.issuer, audience: config.jwt.audience });
    expect(() => verifyToken(t)).toThrow(/invalid algorithm/i);
  });

  test('a validly signed token with no issuer or audience (the old format) is rejected', () => {
    const t = jwt.sign(claims, config.jwt.secret, { algorithm: 'HS256' });
    expect(() => verifyToken(t)).toThrow();
  });

  test('wrong issuer and wrong audience are each rejected', () => {
    const wrongIss = jwt.sign(claims, config.jwt.secret, { algorithm: 'HS256', issuer: 'someone-else', audience: config.jwt.audience });
    const wrongAud = jwt.sign(claims, config.jwt.secret, { algorithm: 'HS256', issuer: config.jwt.issuer, audience: 'another-app' });
    expect(() => verifyToken(wrongIss)).toThrow(/issuer/i);
    expect(() => verifyToken(wrongAud)).toThrow(/audience/i);
  });
});

describe('separate refresh secret', () => {
  const original = config.jwt.refreshSecret;
  afterEach(() => {
    config.jwt.refreshSecret = original;
  });

  test('defaults to the main secret when JWT_REFRESH_SECRET is not set (so deploying this changes nothing)', () => {
    expect(original).toBe(config.jwt.secret);
    expect(verifyToken(signRefreshToken('u1', 0, 's1', 0), 'refresh')).toMatchObject({ type: 'refresh' });
  });

  test('with its own secret, refresh tokens verify only as refresh tokens', () => {
    config.jwt.refreshSecret = 'a-different-refresh-secret-00000000000000000';
    const refresh = signRefreshToken('u1', 0, 's1', 0);
    const access = signAccessToken('u1', { sid: 's1', ver: 0 });
    expect(verifyToken(refresh, 'refresh')).toMatchObject({ type: 'refresh' });
    expect(() => verifyToken(refresh)).toThrow(/signature/i); // not accepted where an access token is expected
    expect(() => verifyToken(access, 'refresh')).toThrow(/signature/i); // and the reverse
    expect(verifyToken(access)).toMatchObject({ type: 'access' });
  });

  test('a refresh token forged with only the ACCESS secret is useless once the refresh secret differs', () => {
    config.jwt.refreshSecret = 'a-different-refresh-secret-00000000000000000';
    const forged = jwt.sign({ id: 'victim', type: 'refresh', ver: 0, sid: 'x', gen: 0 }, config.jwt.secret, {
      algorithm: 'HS256', issuer: config.jwt.issuer, audience: config.jwt.audience,
    });
    expect(() => verifyToken(forged, 'refresh')).toThrow(/signature/i);
  });
});

describe('signing secret strength at boot', () => {
  const boot = (env) => {
    const r = spawnSync(process.execPath, ['-e', "require('./src/config/env')"], {
      cwd: path.join(__dirname, '..'),
      env: { PATH: process.env.PATH, DATABASE_URL: 'postgresql://x@localhost/x', ...env },
      encoding: 'utf8',
    });
    return { status: r.status, output: `${r.stdout}${r.stderr}` };
  };
  const SHORT = 'short-secret';
  const LONG = 'x'.repeat(40);

  test.each([['production'], ['staging'], ['preview']])('a short secret refuses to boot in %s', (nodeEnv) => {
    const r = boot({ NODE_ENV: nodeEnv, JWT_SECRET: SHORT });
    expect(r.status).toBe(1);
    expect(r.output).toMatch(/at least 32/);
  });

  test.each([['development'], ['test'], [undefined]])('a short secret is allowed for local work (NODE_ENV=%s)', (nodeEnv) => {
    expect(boot({ ...(nodeEnv ? { NODE_ENV: nodeEnv } : {}), JWT_SECRET: SHORT }).status).toBe(0);
  });

  test('a long secret boots in production', () => {
    expect(boot({ NODE_ENV: 'production', JWT_SECRET: LONG, STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x', RESEND_API_KEY: 're_x', R2_BUCKET_NAME: 'b', GOOGLE_CLIENT_ID: 'g', SENTRY_DSN: 'https://k@example.invalid/1' }).status).toBe(0);
  });

  test('a short REFRESH secret is refused too, where a refresh secret is configured', () => {
    expect(boot({ NODE_ENV: 'production', JWT_SECRET: LONG, JWT_REFRESH_SECRET: SHORT }).status).toBe(1);
  });
});
