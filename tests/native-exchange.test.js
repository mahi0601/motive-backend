// PKCE (RFC 7636, S256) on the Android native OAuth hand-off. The exchange
// code travels through a custom-scheme deep link that any installed app can
// also register for, so redeeming it must require the code_verifier only the
// legitimate app holds.
const crypto = require('crypto');
const prisma = require('../src/config/prisma');
const AuthService = require('../src/services/auth.service');
const { makeUser, cleanupUsers } = require('./helpers/fixtures');

const newPair = () => {
  const verifier = crypto.randomBytes(32).toString('base64url'); // 43 chars
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
};

describe('native exchange — PKCE', () => {
  let user;

  beforeAll(async () => {
    user = await makeUser('native');
  });

  afterAll(async () => {
    await prisma.nativeExchangeCode.deleteMany({ where: { userId: user.id } });
    await cleanupUsers(user);
    await prisma.$disconnect();
  });

  test('redeems a code with the matching verifier', async () => {
    const { verifier, challenge } = newPair();
    const code = await AuthService.createNativeExchangeCode(user.id, challenge);

    const data = await AuthService.exchangeNativeCode(code, verifier);

    expect(data.user.id).toBe(user.id);
    expect(data.accessToken).toBeTruthy();
    expect(data.refreshToken).toBeTruthy();
  });

  test('rejects a wrong verifier, and the code is burned afterwards', async () => {
    const { verifier, challenge } = newPair();
    const code = await AuthService.createNativeExchangeCode(user.id, challenge);

    await expect(AuthService.exchangeNativeCode(code, newPair().verifier)).rejects.toMatchObject({
      statusCode: 401,
    });
    // The legitimate app's correct attempt now fails too — the interceptor
    // gets exactly one guess and the code is gone either way.
    await expect(AuthService.exchangeNativeCode(code, verifier)).rejects.toMatchObject({ statusCode: 401 });
  });

  test('rejects a missing verifier', async () => {
    const { challenge } = newPair();
    const code = await AuthService.createNativeExchangeCode(user.id, challenge);
    await expect(AuthService.exchangeNativeCode(code, undefined)).rejects.toMatchObject({ statusCode: 401 });
  });

  test('a code cannot be redeemed twice', async () => {
    const { verifier, challenge } = newPair();
    const code = await AuthService.createNativeExchangeCode(user.id, challenge);
    await AuthService.exchangeNativeCode(code, verifier);
    await expect(AuthService.exchangeNativeCode(code, verifier)).rejects.toMatchObject({ statusCode: 401 });
  });

  test('rejects an expired code even with the right verifier', async () => {
    const { verifier, challenge } = newPair();
    const code = await AuthService.createNativeExchangeCode(user.id, challenge);
    await prisma.nativeExchangeCode.update({ where: { code }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(AuthService.exchangeNativeCode(code, verifier)).rejects.toMatchObject({ statusCode: 401 });
  });
});
