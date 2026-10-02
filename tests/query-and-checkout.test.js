// Query strings: Express's default parser turns ?a[$ne]=x into an OBJECT, which
// then flows into database filters. The app uses the simple parser (every value
// is a plain string) and refuses repeated parameters, so a handler never sees a
// shape it did not expect. And a double-clicked "Upgrade" must not create two
// Stripe checkout sessions.
const mockCreate = jest.fn();
// A fake secret key through a partial mock of config/env, as payment.test.js does:
// no STRIPE_SECRET_KEY exists in the test environment, and without one every
// payment call stops at "Payments are not configured".
jest.mock('../src/config/env', () => {
  const actual = jest.requireActual('../src/config/env');
  return { ...actual, stripe: { ...actual.stripe, secretKey: 'sk_test_fake' } };
});
jest.mock('stripe', () => jest.fn().mockImplementation(() => ({
  checkout: { sessions: { create: (...a) => mockCreate(...a), retrieve: jest.fn() } },
})));

const request = require('supertest');
const app = require('../src/app');
const config = require('../src/config/env');
const paymentService = require('../src/services/payment.service');
const { accessTokenFor, makeUser, cleanupUsers } = require('./helpers/fixtures');

describe('query strings', () => {
  let user;
  let auth;
  beforeAll(async () => {
    user = await makeUser('qsUser');
    auth = { Authorization: `Bearer ${await accessTokenFor(user)}` };
  });
  afterAll(async () => cleanupUsers(user));

  test('nested syntax is not turned into an object: it is just an unknown parameter', async () => {
    expect((await request(app).get('/api/tasks?workspaceId[$ne]=x').set(auth)).status).toBe(200);
    expect((await request(app).get('/api/tasks?page[a]=1').set(auth)).status).toBe(200);
  });

  test('a repeated parameter is refused with 400 rather than reaching a handler as an array', async () => {
    const res = await request(app).get('/api/tasks?workspaceId=a&workspaceId=b').set(auth);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test('ordinary queries still work', async () => {
    const res = await request(app).get('/api/tasks?page=1&limit=5').set(auth);
    expect(res.status).toBe(200);
  });

  test('the public status route is protected the same way', async () => {
    expect((await request(app).get(`/api/status/${'a'.repeat(64)}?x=1&x=2`)).status).toBe(400);
  });
});

describe('checkout idempotency', () => {
  const proPricing = config.stripe.proPricing;
  let user;
  beforeAll(async () => {
    user = await makeUser('coUser');
    mockCreate.mockResolvedValue({ url: 'https://checkout.stripe.test/s' });
    if (!proPricing.usd) throw new Error('test needs a usd price');
  });
  beforeEach(() => mockCreate.mockClear());
  afterAll(async () => cleanupUsers(user));

  const keyOf = (call) => mockCreate.mock.calls[call][1]?.idempotencyKey;

  test('every checkout session is created with an idempotency key', async () => {
    await paymentService.createCheckoutSession(user, 'usd');
    expect(keyOf(0)).toMatch(/^[0-9a-f]{40,}$/);
  });

  test('the same user asking twice in a row gets the same key, so Stripe returns the same session', async () => {
    await paymentService.createCheckoutSession(user, 'usd');
    await paymentService.createCheckoutSession(user, 'usd');
    expect(keyOf(0)).toBe(keyOf(1));
  });

  test('a different currency, or a different user, gets a different key', async () => {
    const other = await makeUser('coOther');
    try {
      await paymentService.createCheckoutSession(user, 'usd');
      await paymentService.createCheckoutSession(user, 'inr');
      await paymentService.createCheckoutSession(other, 'usd');
      expect(new Set([keyOf(0), keyOf(1), keyOf(2)]).size).toBe(3);
    } finally {
      await cleanupUsers(other);
    }
  });

  test('the key changes when the request itself changes (Stripe rejects a reused key with different parameters)', async () => {
    await paymentService.createCheckoutSession(user, 'usd');
    const prisma = require('../src/config/prisma');
    await prisma.user.update({ where: { id: user.id }, data: { stripeCustomerId: 'cus_changed' } });
    await paymentService.createCheckoutSession(user, 'usd');
    expect(keyOf(0)).not.toBe(keyOf(1));
  });
});
