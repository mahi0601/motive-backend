// The registry and what rides on it: which gateways are offered for a currency and in what order, that a
// buyer's explicit choice is honoured only when it is really available, that the rest of the app asks
// what a gateway CAN do instead of knowing which one it is, and the shared subscription-state rules.
jest.mock('../src/config/env', () => {
  const actual = jest.requireActual('../src/config/env');
  return {
    ...actual,
    stripe: { ...actual.stripe, secretKey: 'sk_test_fake_key_for_tests' },
    razorpay: { keyId: 'rzp_test_key', keySecret: 'rzp_test_secret', webhookSecret: 'wh', totalCount: 120 },
    paypal: { clientId: 'pp', clientSecret: 'pps', webhookId: 'WH-1', mode: 'sandbox' },
    cashfree: { clientId: 'cf', clientSecret: 'cfs', mode: 'sandbox', apiVersion: '2025-01-01', maxCycles: 120 },
    paymentOrder: { usd: ['stripe', 'paypal'], inr: ['razorpay', 'cashfree', 'stripe'] },
  };
});

const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/prisma');
const config = require('../src/config/env');
const gateways = require('../src/services/gateways');
const paymentService = require('../src/services/payment.service');
const razorpay = require('../src/services/razorpay.service');
const paypal = require('../src/services/paypal.service');
const cashfree = require('../src/services/cashfree.service');
const { applyGatewayState } = require('../src/services/subscriptionState');
const { accessTokenFor, makeUser, cleanupUsers } = require('./helpers/fixtures');

const ids = (list) => list.map((g) => g.id);

describe('gateway registry', () => {
  describe('which gateways are offered, and in what order', () => {
    test('USD: Stripe then PayPal; INR: Razorpay, Cashfree, then Stripe (the configured order)', () => {
      expect(ids(gateways.forCurrency('usd'))).toEqual(['stripe', 'paypal']);
      expect(ids(gateways.forCurrency('inr'))).toEqual(['razorpay', 'cashfree', 'stripe']);
    });

    test('a gateway only appears for currencies it supports', () => {
      expect(ids(gateways.forCurrency('usd'))).not.toContain('razorpay');
      expect(ids(gateways.forCurrency('usd'))).not.toContain('cashfree');
      expect(ids(gateways.forCurrency('inr'))).not.toContain('paypal');
    });

    test('an unconfigured gateway is not offered', () => {
      const saved = { ...config.paypal };
      Object.assign(config.paypal, { clientId: '', clientSecret: '' });
      try {
        expect(ids(gateways.forCurrency('usd'))).toEqual(['stripe']);
      } finally {
        Object.assign(config.paypal, saved);
      }
    });

    test('the order can be changed, and a gateway missing from the order is still offered after the named ones', () => {
      const saved = config.paymentOrder.inr;
      config.paymentOrder.inr = ['cashfree', 'typo-gateway'];
      try {
        // the named one first, then the rest in registry order
        expect(ids(gateways.forCurrency('inr'))).toEqual(['cashfree', 'stripe', 'razorpay']);
      } finally {
        config.paymentOrder.inr = saved;
      }
    });

    test('an unknown currency has no gateways', () => {
      expect(gateways.forCurrency('eur')).toEqual([]);
    });

    test('what the billing card is told has no keys or internals', () => {
      const described = gateways.forCurrency('inr').map(gateways.describe);
      expect(described).toEqual([
        { id: 'razorpay', label: 'Razorpay', needsPhone: false, handoff: 'redirect' },
        { id: 'cashfree', label: 'Cashfree', needsPhone: true, handoff: 'sdk' },
        { id: 'stripe', label: 'Stripe', needsPhone: false, handoff: 'redirect' },
      ]);
      expect(JSON.stringify(described)).not.toMatch(/secret|key|cfs|pps/i);
    });

    test('capabilities: only Stripe has a portal and a plan switch; the others cancel in the app', () => {
      expect(gateways.get('stripe').capabilities).toMatchObject({ portal: true, planSwitch: true, cancel: 'portal' });
      for (const id of ['razorpay', 'paypal', 'cashfree']) {
        expect(gateways.get(id).capabilities).toMatchObject({ portal: false, planSwitch: false, cancel: 'in_app' });
      }
      expect(gateways.get('nope')).toBeNull();
    });
  });

  describe('choosing a gateway at checkout', () => {
    let user;
    beforeEach(async () => {
      user = await makeUser('gw');
    });
    afterEach(async () => {
      await cleanupUsers(user);
      jest.restoreAllMocks();
    });

    test('with no choice, the first gateway for the currency is used', async () => {
      const spy = jest.spyOn(razorpay, 'createCheckout').mockResolvedValue({ url: 'https://rzp.io/x' });
      const res = await paymentService.createCheckoutSession(user, 'inr', 'studio');
      expect(res).toEqual({ provider: 'razorpay', url: 'https://rzp.io/x' });
      expect(spy).toHaveBeenCalledWith(user, 'studio');
    });

    test('an explicit choice is honoured', async () => {
      const spy = jest.spyOn(paypal, 'createCheckout').mockResolvedValue({ url: 'https://paypal/approve' });
      const res = await paymentService.createCheckoutSession(user, 'usd', 'agency', { provider: 'paypal' });
      expect(res).toEqual({ provider: 'paypal', url: 'https://paypal/approve' });
      expect(spy).toHaveBeenCalledWith(user, 'agency', 'usd');
    });

    test('a gateway that does not take the currency is refused with a 400 and nothing is started', async () => {
      const spy = jest.spyOn(paypal, 'createCheckout');
      await expect(paymentService.createCheckoutSession(user, 'inr', 'studio', { provider: 'paypal' })).rejects.toMatchObject({ statusCode: 400 });
      expect(spy).not.toHaveBeenCalled();
    });

    test('an unknown or unconfigured gateway is refused with a 400', async () => {
      await expect(paymentService.createCheckoutSession(user, 'usd', 'studio', { provider: 'bitcoin' })).rejects.toMatchObject({ statusCode: 400 });
      const saved = { ...config.paypal };
      Object.assign(config.paypal, { clientId: '', clientSecret: '' });
      try {
        await expect(paymentService.createCheckoutSession(user, 'usd', 'studio', { provider: 'paypal' })).rejects.toMatchObject({ statusCode: 400 });
      } finally {
        Object.assign(config.paypal, saved);
      }
    });

    test('Cashfree gets the phone and returns a session for the SDK, not a URL', async () => {
      const spy = jest.spyOn(cashfree, 'createCheckout').mockResolvedValue({ sessionId: 's1', mode: 'sandbox' });
      const res = await paymentService.createCheckoutSession(user, 'inr', 'studio', { provider: 'cashfree', phone: '9876543210' });
      expect(res).toEqual({ provider: 'cashfree', sessionId: 's1', mode: 'sandbox' });
      expect(spy).toHaveBeenCalledWith(user, 'studio', 'inr', { phone: '9876543210' });
    });

    test('someone already Pro is refused before any gateway is touched', async () => {
      const spy = jest.spyOn(razorpay, 'createCheckout');
      await expect(paymentService.createCheckoutSession({ ...user, isPro: true }, 'inr', 'studio')).rejects.toMatchObject({ statusCode: 400 });
      expect(spy).not.toHaveBeenCalled();
    });

    test('with no gateway for the currency it is a clear 503', async () => {
      await expect(paymentService.createCheckoutSession(user, 'eur', 'studio')).rejects.toMatchObject({ statusCode: 503 });
    });

    test('over HTTP: the body carries the choice and phone; the answer carries the provider', async () => {
      jest.spyOn(cashfree, 'createCheckout').mockResolvedValue({ sessionId: 's2', mode: 'sandbox' });
      const res = await request(app)
        .post('/api/payments/create-checkout-session')
        .set('Authorization', `Bearer ${await accessTokenFor(user)}`)
        .send({ currency: 'inr', plan: 'studio', provider: 'cashfree', phone: '9876543210' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, provider: 'cashfree', sessionId: 's2', mode: 'sandbox' });
    });

    test('over HTTP: a non-string choice or an over-long phone is a 422', async () => {
      const auth = { Authorization: `Bearer ${await accessTokenFor(user)}` };
      expect((await request(app).post('/api/payments/create-checkout-session').set(auth).send({ currency: 'inr', provider: { $ne: 1 } })).status).toBe(422);
      expect((await request(app).post('/api/payments/create-checkout-session').set(auth).send({ currency: 'inr', phone: '9'.repeat(21) })).status).toBe(422);
    });

    test('GET /options lists each currency\'s gateways in order', async () => {
      const res = await request(app).get('/api/payments/options').set('Authorization', `Bearer ${await accessTokenFor(user)}`);
      expect(res.body.options.usd.map((g) => g.id)).toEqual(['stripe', 'paypal']);
      expect(res.body.options.inr.map((g) => g.id)).toEqual(['razorpay', 'cashfree', 'stripe']);
    });

    test('sync for a user with no gateway just reports the stored state, and cancel says to use Manage billing', async () => {
      expect(await paymentService.syncForUser(user.id)).toEqual({ isPro: false, status: null });
      await expect(paymentService.cancelForUser(user.id)).rejects.toMatchObject({ statusCode: 400 });
    });
  });
});

describe('shared subscription state', () => {
  let user;
  beforeEach(async () => {
    user = await makeUser('ss');
  });
  afterEach(async () => cleanupUsers(user));
  afterAll(async () => prisma.$disconnect());

  const apply = (over = {}) =>
    applyGatewayState({
      provider: 'paypal', idColumn: 'paypalSubscriptionId', id: 'I-1', userHint: user.id,
      state: { status: 'active', paid: true, inFlight: false, ended: false, periodEnd: new Date(Date.now() + 86400000), plan: 'studio' }, ...over,
    });
  const reload = () => prisma.user.findUnique({ where: { id: user.id } });

  test('a subscription that is not ours returns null and changes nothing', async () => {
    expect(await applyGatewayState({ provider: 'paypal', idColumn: 'paypalSubscriptionId', id: 'I-X', userHint: 'nobody', state: { status: 'active', paid: true, plan: 'studio' } })).toBeNull();
    expect(await applyGatewayState({ provider: 'paypal', idColumn: 'paypalSubscriptionId', id: undefined, state: {} })).toBeNull();
  });

  test('a gateway that cannot say which plan keeps the one the user has, or defaults to Studio', async () => {
    await prisma.user.update({ where: { id: user.id }, data: { plan: 'agency' } });
    await apply({ state: { status: 'active', paid: true, ended: false, periodEnd: null, plan: null } });
    expect((await reload()).plan).toBe('agency');
    await prisma.user.update({ where: { id: user.id }, data: { plan: 'free', isPro: false } });
    await apply({ state: { status: 'active', paid: true, ended: false, periodEnd: null, plan: null } });
    expect((await reload()).plan).toBe('studio');
  });

  test('a missing period end keeps the stored one', async () => {
    const end = new Date(Date.now() + 5 * 86400000);
    await prisma.user.update({ where: { id: user.id }, data: { proPeriodEnd: end } });
    await apply({ state: { status: 'active', paid: true, ended: false, periodEnd: null, plan: 'studio' } });
    expect((await reload()).proPeriodEnd.toISOString()).toBe(end.toISOString());
  });

  test('"paid until" is honoured only for gateways that ask for it, only when the buyer cancelled, and only before the date', async () => {
    const ended = { status: 'canceled', paid: false, inFlight: false, ended: true, periodEnd: null, plan: 'studio' };
    const setup = (cancelled, daysLeft) =>
      prisma.user.update({ where: { id: user.id }, data: { isPro: true, plan: 'studio', subscriptionStatus: 'active', subscriptionCancelAtPeriodEnd: cancelled, proPeriodEnd: new Date(Date.now() + daysLeft * 86400000) } });

    await setup(true, 5);
    await apply({ state: ended, honourPaidUntil: true });
    expect(await reload()).toMatchObject({ isPro: true, subscriptionStatus: 'active', subscriptionCancelAtPeriodEnd: true });

    await setup(true, 5);
    await apply({ state: ended, honourPaidUntil: false }); // a gateway that cancels at the cycle end itself
    expect((await reload()).isPro).toBe(false);

    await setup(false, 5); // ended by the gateway, not cancelled by the buyer (e.g. payments failed)
    await apply({ state: ended, honourPaidUntil: true });
    expect((await reload()).isPro).toBe(false);

    await setup(true, -1); // the date has passed
    await apply({ state: ended, honourPaidUntil: true });
    expect((await reload()).isPro).toBe(false);
  });

  test('a duplicate that is only "in flight" is also cancelled for someone already paying', async () => {
    await apply();
    const cancelled = [];
    await apply({ id: 'I-2', state: { status: 'incomplete', paid: false, inFlight: true, ended: false, plan: 'studio' }, cancelDuplicate: async (id) => cancelled.push(id) });
    expect(cancelled).toEqual(['I-2']);
    expect((await prisma.user.findUnique({ where: { id: user.id }, omit: { paypalSubscriptionId: false } })).paypalSubscriptionId).toBe('I-1');
  });

  test('a failing duplicate cancel is logged, not thrown, and the user is left untouched', async () => {
    await apply();
    await expect(apply({ id: 'I-3', cancelDuplicate: async () => { throw new Error('down'); } })).resolves.toBe(user.id);
    expect((await reload()).isPro).toBe(true);
  });
});
