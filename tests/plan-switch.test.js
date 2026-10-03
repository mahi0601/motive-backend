// A Studio subscriber can move to Agency in the app: the existing Stripe
// subscription is repriced (prorated) rather than a second one being created.
// Only that one upgrade is offered; a downgrade is a separate decision (what
// happens to clients over the new limit) and is deliberately not here.
const mockRetrieve = jest.fn();
const mockUpdate = jest.fn();
const mockProductCreate = jest.fn();
jest.mock('../src/config/env', () => {
  const actual = jest.requireActual('../src/config/env');
  return { ...actual, stripe: { ...actual.stripe, secretKey: 'sk_test_fake' } };
});
jest.mock('stripe', () => jest.fn().mockImplementation(() => ({
  checkout: { sessions: { create: jest.fn(), retrieve: jest.fn() } },
  subscriptions: { retrieve: (...a) => mockRetrieve(...a), update: (...a) => mockUpdate(...a), cancel: jest.fn() },
  products: { create: (...a) => mockProductCreate(...a) },
})));

const request = require('supertest');
const app = require('../src/app');
const config = require('../src/config/env');
const prisma = require('../src/config/prisma');
const paymentService = require('../src/services/payment.service');
const { accessTokenFor, makeUser, cleanupUsers } = require('./helpers/fixtures');

let n = 0;
const liveSub = (user, extra = {}) => ({
  id: user.subId,
  status: 'active',
  cancel_at_period_end: false,
  currency: 'usd',
  metadata: { userId: user.id, plan: 'studio' },
  items: { data: [{ id: 'si_1', price: { currency: 'usd' }, current_period_end: Math.floor(Date.now() / 1000) + 86400 }] },
  ...extra,
});

describe('changePlan (Studio to Agency)', () => {
  const made = [];
  afterAll(async () => {
    await cleanupUsers(...made);
    await prisma.$disconnect();
  });

  const studioUser = async (label, overrides = {}) => {
    const subId = `sub_switch_${Date.now()}_${n++}`;
    const u = await makeUser(label, { isPro: true, plan: 'studio', stripeSubscriptionId: subId, subscriptionStatus: 'active', ...overrides });
    u.subId = subId;
    made.push(u);
    return u;
  };
  const reload = (u) => prisma.user.findUnique({ where: { id: u.id } });

  beforeEach(() => {
    mockRetrieve.mockReset();
    mockUpdate.mockReset();
    mockProductCreate.mockReset().mockResolvedValue({ id: 'prod_agency_new' });
  });

  test('reprices the existing subscription with proration, and records the new plan', async () => {
    const u = await studioUser('sw-ok');
    mockRetrieve.mockResolvedValue(liveSub(u));
    mockUpdate.mockImplementation(async (id, params) => liveSub(u, { metadata: params.metadata }));

    const result = await paymentService.changePlan(u.id, 'agency');

    expect(mockProductCreate).toHaveBeenCalledWith({ name: 'Clientglass Agency — monthly' }, expect.any(Object));
    const [subId, params, opts] = mockUpdate.mock.calls[0];
    expect(subId).toBe(u.subId);
    expect(params.items).toEqual([
      {
        id: 'si_1',
        price_data: { currency: 'usd', product: 'prod_agency_new', unit_amount: config.stripe.plans.agency.usd.amount, recurring: { interval: 'month' } },
      },
    ]);
    expect(params.proration_behavior).toBe('create_prorations');
    expect(params.metadata).toEqual({ userId: u.id, plan: 'agency' });
    expect(opts.idempotencyKey).toMatch(/^[0-9a-f]{40,}$/);
    expect(result).toEqual({ tier: 'agency' });
    expect(await reload(u)).toMatchObject({ plan: 'agency', isPro: true });
  });

  test('charges in the currency the subscription is already in', async () => {
    const u = await studioUser('sw-inr');
    mockRetrieve.mockResolvedValue(liveSub(u, { currency: 'inr', items: { data: [{ id: 'si_1', price: { currency: 'inr' } }] } }));
    mockUpdate.mockImplementation(async (id, params) => liveSub(u, { metadata: params.metadata }));
    await paymentService.changePlan(u.id, 'agency');
    expect(mockUpdate.mock.calls[0][1].items[0].price_data).toMatchObject({ currency: 'inr', unit_amount: config.stripe.plans.agency.inr.amount });
  });

  test('the same switch twice in a row uses the same idempotency key, so Stripe applies it once', async () => {
    const u = await studioUser('sw-idem');
    mockRetrieve.mockResolvedValue(liveSub(u));
    mockUpdate.mockImplementation(async (id, params) => liveSub(u, { metadata: params.metadata }));
    await paymentService.changePlan(u.id, 'agency');
    await prisma.user.update({ where: { id: u.id }, data: { plan: 'studio' } }); // as if the first webhook had not landed
    await paymentService.changePlan(u.id, 'agency');
    expect(mockUpdate.mock.calls[0][2].idempotencyKey).toBe(mockUpdate.mock.calls[1][2].idempotencyKey);
  });

  test('is recorded in the audit trail with the plans, never anything personal', async () => {
    const u = await studioUser('sw-audit');
    mockRetrieve.mockResolvedValue(liveSub(u));
    mockUpdate.mockImplementation(async (id, params) => liveSub(u, { metadata: params.metadata }));
    await paymentService.changePlan(u.id, 'agency');
    const rows = await prisma.securityEvent.findMany({ where: { type: 'plan_changed', targetUserId: u.id } });
    expect(rows.some((r) => r.meta?.from === 'studio' && r.meta?.to === 'agency')).toBe(true);
  });

  describe('refused before Stripe is changed', () => {
    const refused = async (u, plan = 'agency') => {
      await expect(paymentService.changePlan(u.id, plan)).rejects.toMatchObject({ statusCode: 400 });
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockProductCreate).not.toHaveBeenCalled();
    };

    test('a downgrade or an unknown plan', async () => {
      const u = await studioUser('sw-down');
      await refused(u, 'studio');
      await refused(u, 'free');
      await refused(u, 'platinum');
    });

    test('a free account (it should subscribe from the plan cards)', async () => {
      const u = await makeUser('sw-free');
      made.push(u);
      await refused(u);
    });

    test('someone already on Agency, and a lifetime-Pro user', async () => {
      await refused(await studioUser('sw-agency', { plan: 'agency' }));
      await refused(await studioUser('sw-life', { proLifetime: true }));
    });

    test('a paid account with no subscription to change', async () => {
      const u = await makeUser('sw-nosub', { isPro: true, plan: 'studio' });
      made.push(u);
      await refused(u);
    });

    test.each(['past_due', 'unpaid', 'canceled', 'incomplete'])('a subscription that is %s', async (status) => {
      const u = await studioUser(`sw-${status}`);
      mockRetrieve.mockResolvedValue(liveSub(u, { status }));
      await refused(u);
    });

    test('a subscription already set to end at the period end', async () => {
      const u = await studioUser('sw-ending');
      mockRetrieve.mockResolvedValue(liveSub(u, { cancel_at_period_end: true }));
      await refused(u);
    });

    test('a currency that has no Agency price', async () => {
      const u = await studioUser('sw-eur');
      mockRetrieve.mockResolvedValue(liveSub(u, { currency: 'eur', items: { data: [{ id: 'si_1', price: { currency: 'eur' } }] } }));
      await refused(u);
    });

    test('a subscription with no items', async () => {
      const u = await studioUser('sw-noitems');
      mockRetrieve.mockResolvedValue(liveSub(u, { items: { data: [] } }));
      await expect(paymentService.changePlan(u.id, 'agency')).rejects.toMatchObject({ statusCode: expect.any(Number) });
      expect(mockUpdate).not.toHaveBeenCalled();
    });
  });

  test('if Stripe fails, the plan is unchanged and the user gets a clear 502', async () => {
    const u = await studioUser('sw-fail');
    mockRetrieve.mockResolvedValue(liveSub(u));
    mockUpdate.mockRejectedValue(new Error('stripe is down'));
    await expect(paymentService.changePlan(u.id, 'agency')).rejects.toMatchObject({ statusCode: 502, message: expect.stringMatching(/could not change your plan/i) });
    expect(await reload(u)).toMatchObject({ plan: 'studio' });
  });

  test('if Stripe cannot be read, nothing is changed', async () => {
    const u = await studioUser('sw-readfail');
    mockRetrieve.mockRejectedValue(new Error('timeout'));
    await expect(paymentService.changePlan(u.id, 'agency')).rejects.toMatchObject({ statusCode: 502 });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  describe('over HTTP', () => {
    const post = async (u, body) => request(app).post('/api/payments/change-plan').set({ Authorization: `Bearer ${await accessTokenFor(u)}` }).send(body);

    test('needs a signed-in user', async () => {
      expect((await request(app).post('/api/payments/change-plan').send({ plan: 'agency' })).status).toBe(401);
    });

    test('rejects anything but a valid plan with 422', async () => {
      const u = await studioUser('sw-http-bad');
      expect((await post(u, { plan: 'platinum' })).status).toBe(422);
      expect((await post(u, {})).status).toBe(422);
    });

    test('switches and reports the new tier', async () => {
      const u = await studioUser('sw-http-ok');
      mockRetrieve.mockResolvedValue(liveSub(u));
      mockUpdate.mockImplementation(async (id, params) => liveSub(u, { metadata: params.metadata }));
      const res = await post(u, { plan: 'agency' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, tier: 'agency' });
    });

    test('is rate limited, because each call can reach Stripe', async () => {
      const u = await studioUser('sw-http-rl');
      const statuses = [];
      for (let i = 0; i < 15; i++) statuses.push((await post(u, { plan: 'platinum' })).status);
      expect(statuses).toContain(429);
    });
  });
});
