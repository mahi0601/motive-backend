// Checkout takes a plan (studio | agency); the webhook records which one, and
// anything without a plan on it (a subscription from before tiers existed)
// counts as Agency, so nobody who already pays loses anything.
const mockCreate = jest.fn();
jest.mock('../src/config/env', () => {
  const actual = jest.requireActual('../src/config/env');
  return { ...actual, stripe: { ...actual.stripe, secretKey: 'sk_test_fake' } };
});
jest.mock('stripe', () => jest.fn().mockImplementation(() => ({
  checkout: { sessions: { create: (...a) => mockCreate(...a), retrieve: jest.fn() } },
  subscriptions: { retrieve: jest.fn(), cancel: jest.fn() },
})));

const request = require('supertest');
const app = require('../src/app');
const config = require('../src/config/env');
const prisma = require('../src/config/prisma');
const paymentService = require('../src/services/payment.service');
const { accessTokenFor, makeUser, cleanupUsers } = require('./helpers/fixtures');

const lineItem = () => mockCreate.mock.calls.at(-1)[0].line_items[0].price_data;
const params = () => mockCreate.mock.calls.at(-1)[0];

describe('plan prices', () => {
  test('the defaults the pricing page shows (placeholders, set per environment)', () => {
    const { studio, agency } = config.stripe.plans;
    expect(studio.usd.amount).toBe(1900);
    expect(studio.inr.amount).toBe(99900);
    expect(agency.usd.amount).toBe(4900);
    expect(agency.inr.amount).toBe(249900);
  });
});

describe('createCheckoutSession with a plan', () => {
  let user;
  beforeAll(async () => {
    user = await makeUser('plan-checkout');
  });
  beforeEach(() => mockCreate.mockReset().mockResolvedValue({ url: 'https://checkout.stripe.test/s' }));
  afterAll(async () => {
    await cleanupUsers(user);
    await prisma.$disconnect();
  });

  test('Studio in USD: its own product name, amount and metadata', async () => {
    await paymentService.createCheckoutSession(user, 'usd', 'studio');
    expect(lineItem().product_data.name).toBe('Clientglass Studio — monthly');
    expect(lineItem().unit_amount).toBe(config.stripe.plans.studio.usd.amount);
    expect(lineItem().recurring).toEqual({ interval: 'month' });
    expect(params().metadata).toEqual({ userId: user.id, plan: 'studio' });
    expect(params().subscription_data.metadata).toEqual({ userId: user.id, plan: 'studio' });
  });

  test('Agency in INR', async () => {
    await paymentService.createCheckoutSession(user, 'inr', 'agency');
    expect(lineItem().product_data.name).toBe('Clientglass Agency — monthly');
    expect(lineItem().currency).toBe('inr');
    expect(lineItem().unit_amount).toBe(config.stripe.plans.agency.inr.amount);
    expect(params().subscription_data.metadata.plan).toBe('agency');
  });

  test('no plan given means Studio, the entry paid tier, not the most expensive one', async () => {
    await paymentService.createCheckoutSession(user, 'usd');
    expect(params().metadata.plan).toBe('studio');
  });

  test('an unknown plan is refused before Stripe is called', async () => {
    await expect(paymentService.createCheckoutSession(user, 'usd', 'platinum')).rejects.toMatchObject({ statusCode: 400 });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('"free" is not something you can buy', async () => {
    await expect(paymentService.createCheckoutSession(user, 'usd', 'free')).rejects.toMatchObject({ statusCode: 400 });
  });

  test('different plans never share an idempotency key', async () => {
    await paymentService.createCheckoutSession(user, 'usd', 'studio');
    await paymentService.createCheckoutSession(user, 'usd', 'agency');
    const [k1, k2] = mockCreate.mock.calls.map((c) => c[1].idempotencyKey);
    expect(k1).not.toBe(k2);
  });

  test('someone who is already paid is told so', async () => {
    await expect(paymentService.createCheckoutSession({ ...user, isPro: true }, 'usd', 'agency')).rejects.toMatchObject({ statusCode: 400 });
  });

  test('over HTTP, an unknown plan is a 422 and a valid one reaches Stripe', async () => {
    const auth = { Authorization: `Bearer ${await accessTokenFor(user)}` };
    const bad = await request(app).post('/api/payments/create-checkout-session').set(auth).send({ plan: 'platinum' });
    expect(bad.status).toBe(422);
    const ok = await request(app).post('/api/payments/create-checkout-session').set(auth).send({ plan: 'agency', currency: 'usd' });
    expect(ok.status).toBe(200);
    expect(params().metadata.plan).toBe('agency');
  });
});

describe('the webhook records the plan', () => {
  const made = [];
  afterAll(async () => cleanupUsers(...made));
  let n = 0;
  const subscription = (user, extra = {}) => ({
    id: `sub_plan_${Date.now()}_${n++}`,
    status: 'active',
    metadata: { userId: user.id },
    items: { data: [{ current_period_end: Math.floor(Date.now() / 1000) + 86400 }] },
    ...extra,
  });
  const send = (type, object) => paymentService.handleWebhookEvent({ id: `evt_plan_${Date.now()}_${n++}`, type, data: { object } });
  const reload = (u) => prisma.user.findUnique({ where: { id: u.id } });
  const fresh = async (label, overrides) => {
    const u = await makeUser(label, overrides);
    made.push(u);
    return u;
  };

  test('a Studio subscription sets plan studio and isPro', async () => {
    const u = await fresh('wh-studio');
    await send('customer.subscription.created', subscription(u, { metadata: { userId: u.id, plan: 'studio' } }));
    expect(await reload(u)).toMatchObject({ isPro: true, plan: 'studio' });
  });

  test('an Agency subscription sets plan agency', async () => {
    const u = await fresh('wh-agency');
    await send('customer.subscription.created', subscription(u, { metadata: { userId: u.id, plan: 'agency' } }));
    expect(await reload(u)).toMatchObject({ isPro: true, plan: 'agency' });
  });

  test('a subscription with no plan on it (created before tiers) becomes Agency', async () => {
    const u = await fresh('wh-legacy');
    await send('customer.subscription.created', subscription(u));
    expect(await reload(u)).toMatchObject({ isPro: true, plan: 'agency' });
  });

  test('a nonsense plan value on a subscription falls back to Agency, never to anything cheaper or invalid', async () => {
    const u = await fresh('wh-weird');
    await send('customer.subscription.created', subscription(u, { metadata: { userId: u.id, plan: 'free' } }));
    expect(await reload(u)).toMatchObject({ isPro: true, plan: 'agency' });
  });

  test('cancelling puts the account back on free', async () => {
    const u = await fresh('wh-cancel');
    const sub = subscription(u, { metadata: { userId: u.id, plan: 'studio' } });
    await send('customer.subscription.created', sub);
    await send('customer.subscription.deleted', { ...sub, status: 'canceled' });
    expect(await reload(u)).toMatchObject({ isPro: false, plan: 'free' });
  });

  test('a lifetime-Pro user stays Agency even when a subscription ends', async () => {
    const u = await fresh('wh-lifetime', { isPro: true, proLifetime: true, plan: 'agency' });
    const sub = subscription(u, { metadata: { userId: u.id, plan: 'studio' } });
    await send('customer.subscription.created', sub);
    await send('customer.subscription.deleted', { ...sub, status: 'canceled' });
    expect(await reload(u)).toMatchObject({ isPro: true, plan: 'agency' });
  });

  test('moving from Studio to Agency on an existing subscription updates the plan', async () => {
    const u = await fresh('wh-upgrade');
    const sub = subscription(u, { metadata: { userId: u.id, plan: 'studio' } });
    await send('customer.subscription.created', sub);
    await send('customer.subscription.updated', { ...sub, metadata: { userId: u.id, plan: 'agency' } });
    expect(await reload(u).then((r) => r.plan)).toBe('agency');
  });
});
