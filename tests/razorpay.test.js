// Razorpay: INR subscriptions for buyers in India. Real-money logic, so the tests pin what
// matters: which gateway takes which currency, that a plan is created once and reused, that a
// double-click cannot start two subscriptions, that the webhook is signed and idempotent and
// moves the user's flags exactly as Stripe's does, that nobody is cut off mid-retry or given
// access before paying, and that account deletion refuses to leave a subscription billing.
// Razorpay itself is mocked at `fetch`; the database is real.
jest.mock('../src/config/env', () => {
  const actual = jest.requireActual('../src/config/env');
  return {
    ...actual,
    stripe: { ...actual.stripe, secretKey: 'sk_test_fake_key_for_tests' },
    razorpay: { keyId: 'rzp_test_key', keySecret: 'rzp_test_secret', webhookSecret: 'whsec_razorpay_test', totalCount: 120 },
  };
});

const crypto = require('crypto');
const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/prisma');
const config = require('../src/config/env');
const paymentService = require('../src/services/payment.service');
const razorpay = require('../src/services/razorpay.service');
const { accessTokenFor, makeUser, cleanupUsers } = require('./helpers/fixtures');

// A tiny fake of Razorpay's API. `routes` maps "METHOD /path" to a body or a function; calls are recorded.
const calls = [];
const reply = (routes) => {
  global.fetch = jest.fn(async (url, init = {}) => {
    const path = String(url).replace('https://api.razorpay.com/v1', '');
    const key = `${init.method || 'GET'} ${path.replace(/\/(plan|sub)_[A-Za-z0-9]+/, (m, k) => `/${k}_ID`)}`;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ key, body, auth: init.headers?.Authorization });
    const hit = routes[key];
    if (hit === undefined) return { ok: false, status: 404, json: async () => ({ error: { code: 'NOT_FOUND' } }) };
    const out = typeof hit === 'function' ? hit(body) : hit;
    if (out && out.__error) return { ok: false, status: out.__error, json: async () => ({ error: { code: out.code || 'BAD_REQUEST_ERROR', description: 'secret detail' } }) };
    return { ok: true, status: 200, json: async () => out };
  });
};
const made = (key) => calls.filter((c) => c.key === key);

const entityFor = (user, over = {}) => ({
  id: 'sub_TEST1', entity: 'subscription', plan_id: 'plan_TEST1', status: 'active', notes: { userId: user.id, plan: 'studio' },
  current_end: Math.floor(Date.now() / 1000) + 30 * 86400, ...over,
});
const eventFor = (user, name, over = {}) => ({ event: name, payload: { subscription: { entity: entityFor(user, over) } } });
const sign = (raw, secret = config.razorpay.webhookSecret) => crypto.createHmac('sha256', secret).update(raw).digest('hex');
const reload = (user) => prisma.user.findUnique({ where: { id: user.id }, omit: { razorpaySubscriptionId: false } });
let seq = 0;
const eid = () => `evt_${Date.now()}_${seq++}`;

describe('razorpay', () => {
  let user;
  beforeEach(async () => {
    calls.length = 0;
    await prisma.providerPlan.deleteMany({});
    user = await makeUser('rzp');
  });
  afterEach(async () => {
    await cleanupUsers(user);
    jest.restoreAllMocks();
  });
  afterAll(async () => {
    await prisma.providerPlan.deleteMany({});
    await prisma.$disconnect();
  });

  describe('which gateway takes which currency', () => {
    test('INR goes to Razorpay when configured, USD stays on Stripe', () => {
      expect(paymentService.providerFor('inr')).toBe('razorpay');
      expect(paymentService.providerFor('usd')).toBe('stripe');
      expect(paymentService.getOptions()).toEqual({ usd: 'stripe', inr: 'razorpay' });
    });

    test('INR falls back to Stripe without Razorpay keys, and to nothing without either', () => {
      const saved = { ...config.razorpay };
      Object.assign(config.razorpay, { keyId: '', keySecret: '' });
      expect(paymentService.providerFor('inr')).toBe('stripe');
      const stripeKey = config.stripe.secretKey;
      config.stripe.secretKey = '';
      expect(paymentService.getOptions()).toEqual({ usd: null, inr: null });
      config.stripe.secretKey = stripeKey;
      Object.assign(config.razorpay, saved);
    });

    test('with no provider for the currency, checkout is a clear 503, not a 500', async () => {
      const stripeKey = config.stripe.secretKey;
      config.stripe.secretKey = '';
      await expect(paymentService.createCheckoutSession(user, 'usd', 'studio')).rejects.toMatchObject({ statusCode: 503 });
      config.stripe.secretKey = stripeKey;
    });
  });

  describe('starting a checkout', () => {
    const routes = () => ({
      'POST /plans': { id: 'plan_NEW1' },
      'POST /subscriptions': { id: 'sub_NEW1', status: 'created', short_url: 'https://rzp.io/i/abc', notes: { plan: 'studio' } },
    });

    test('creates the plan once, then the subscription with the buyer and plan in its notes, and returns the payment link', async () => {
      reply(routes());
      const res = await paymentService.createCheckoutSession(user, 'inr', 'studio');
      expect(res).toEqual({ url: 'https://rzp.io/i/abc', provider: 'razorpay' });
      const plan = made('POST /plans')[0].body;
      expect(plan).toMatchObject({ period: 'monthly', interval: 1, item: { amount: config.stripe.plans.studio.inr.amount, currency: 'INR' } });
      const sub = made('POST /subscriptions')[0].body;
      expect(sub).toMatchObject({ plan_id: 'plan_NEW1', total_count: 120, notes: { userId: user.id, plan: 'studio' } });
      expect(sub.expire_by).toBeGreaterThan(Date.now() / 1000);
      expect(made('POST /plans')[0].auth).toBe(`Basic ${Buffer.from('rzp_test_key:rzp_test_secret').toString('base64')}`);
    });

    test('remembers the subscription id but grants nothing until it is paid', async () => {
      reply(routes());
      await paymentService.createCheckoutSession(user, 'inr', 'studio');
      const row = await reload(user);
      expect(row).toMatchObject({ razorpaySubscriptionId: 'sub_NEW1', paymentProvider: 'razorpay', isPro: false, plan: 'free' });
    });

    test('a second plan of the same price reuses the plan instead of creating another', async () => {
      reply(routes());
      await paymentService.createCheckoutSession(user, 'inr', 'studio');
      await prisma.user.update({ where: { id: user.id }, data: { razorpaySubscriptionId: null } });
      calls.length = 0;
      reply({ 'POST /subscriptions': { id: 'sub_NEW2', status: 'created', short_url: 'https://rzp.io/i/def' } });
      await paymentService.createCheckoutSession(user, 'inr', 'studio');
      expect(made('POST /plans')).toHaveLength(0);
      expect(made('POST /subscriptions')[0].body.plan_id).toBe('plan_NEW1');
    });

    test('a changed price makes a NEW plan and leaves the old one alone', async () => {
      reply(routes());
      await paymentService.createCheckoutSession(user, 'inr', 'studio');
      const original = config.stripe.plans.studio.inr.amount;
      config.stripe.plans.studio.inr.amount = original + 100;
      try {
        await prisma.user.update({ where: { id: user.id }, data: { razorpaySubscriptionId: null } });
        calls.length = 0;
        reply({ 'POST /plans': { id: 'plan_NEW2' }, 'POST /subscriptions': { id: 'sub_NEW3', status: 'created', short_url: 'https://rzp.io/i/ghi' } });
        await paymentService.createCheckoutSession(user, 'inr', 'studio');
        expect(made('POST /plans')).toHaveLength(1);
        expect(await prisma.providerPlan.count({ where: { provider: 'razorpay', plan: 'studio' } })).toBe(2);
      } finally {
        config.stripe.plans.studio.inr.amount = original;
      }
    });

    test('a double-click gets the SAME unpaid link, not a second subscription', async () => {
      reply(routes());
      await paymentService.createCheckoutSession(user, 'inr', 'studio');
      calls.length = 0;
      reply({ 'GET /subscriptions/sub_ID': { id: 'sub_NEW1', status: 'created', short_url: 'https://rzp.io/i/abc', notes: { plan: 'studio' }, expire_by: Math.floor(Date.now() / 1000) + 3600 } });
      const again = await paymentService.createCheckoutSession(user, 'inr', 'studio');
      expect(again.url).toBe('https://rzp.io/i/abc');
      expect(made('POST /subscriptions')).toHaveLength(0);
    });

    test('a different plan, or an expired link, starts a new subscription', async () => {
      reply(routes());
      await paymentService.createCheckoutSession(user, 'inr', 'studio');
      calls.length = 0;
      reply({
        'GET /subscriptions/sub_ID': { id: 'sub_NEW1', status: 'created', short_url: 'https://rzp.io/i/abc', notes: { plan: 'studio' } },
        'POST /plans': { id: 'plan_AG1' },
        'POST /subscriptions': { id: 'sub_AG1', status: 'created', short_url: 'https://rzp.io/i/agency' },
      });
      expect((await paymentService.createCheckoutSession(user, 'inr', 'agency')).url).toBe('https://rzp.io/i/agency');
    });

    test('someone who is already Pro is refused, and an unknown plan is a 400', async () => {
      reply(routes());
      await expect(paymentService.createCheckoutSession({ ...user, isPro: true }, 'inr', 'studio')).rejects.toMatchObject({ statusCode: 400 });
      await expect(paymentService.createCheckoutSession(user, 'inr', 'platinum')).rejects.toMatchObject({ statusCode: 400 });
    });

    test('a Razorpay failure is a 502 with a plain message that does not repeat what Razorpay said', async () => {
      reply({ 'POST /plans': { __error: 400, code: 'BAD_REQUEST_ERROR' } });
      const err = await paymentService.createCheckoutSession(user, 'inr', 'studio').catch((e) => e);
      expect(err.statusCode).toBe(502);
      expect(err.message).not.toMatch(/secret detail/);
    });

    test('an unreachable Razorpay is a 502 as well', async () => {
      global.fetch = jest.fn(async () => {
        throw new Error('network down');
      });
      await expect(paymentService.createCheckoutSession(user, 'inr', 'studio')).rejects.toMatchObject({ statusCode: 502 });
    });
  });

  describe('the webhook: signature', () => {
    const raw = (obj) => Buffer.from(JSON.stringify(obj));

    test('a correctly signed body is accepted and parsed', () => {
      const body = raw({ event: 'subscription.activated' });
      expect(razorpay.verifyWebhook(body, sign(body))).toEqual({ event: 'subscription.activated' });
    });

    test.each([
      ['a wrong signature', () => sign(Buffer.from('other'))],
      ['a signature made with another secret', (b) => sign(b, 'not-the-secret')],
      ['an empty signature', () => ''],
      ['no signature', () => undefined],
      ['a shorter signature', () => 'abc'],
    ])('rejects %s', (_l, make) => {
      const body = raw({ event: 'subscription.activated' });
      expect(() => razorpay.verifyWebhook(body, make(body))).toThrow();
    });

    test('a body changed after signing is rejected', () => {
      const body = raw({ event: 'subscription.activated', payload: { amount: 1 } });
      const sig = sign(body);
      expect(() => razorpay.verifyWebhook(raw({ event: 'subscription.activated', payload: { amount: 999 } }), sig)).toThrow();
    });

    test('with no webhook secret configured it refuses everything', () => {
      const saved = config.razorpay.webhookSecret;
      config.razorpay.webhookSecret = '';
      expect(() => razorpay.verifyWebhook(raw({}), 'x')).toThrow(/not configured/);
      config.razorpay.webhookSecret = saved;
    });

    test('over HTTP: a good signature gets 200, a bad one gets 400 and changes nothing', async () => {
      const body = JSON.stringify(eventFor(user, 'subscription.activated'));
      const bad = await request(app).post('/api/payments/razorpay/webhook').set('Content-Type', 'application/json').set('x-razorpay-signature', 'nope').send(body);
      expect(bad.status).toBe(400);
      expect((await reload(user)).isPro).toBe(false);
      const good = await request(app)
        .post('/api/payments/razorpay/webhook')
        .set('Content-Type', 'application/json')
        .set('x-razorpay-signature', sign(Buffer.from(body)))
        .set('x-razorpay-event-id', eid())
        .send(body);
      expect(good.status).toBe(200);
      expect((await reload(user)).isPro).toBe(true);
    });
  });

  describe('the webhook: what each event does to the user', () => {
    const fire = (name, over, id = eid()) => razorpay.handleWebhook(eventFor(user, name, over), { eventId: id });

    test('activated grants the plan from the notes, the period end and the provider', async () => {
      await fire('subscription.activated');
      const row = await reload(user);
      expect(row).toMatchObject({ isPro: true, plan: 'studio', subscriptionStatus: 'active', paymentProvider: 'razorpay', razorpaySubscriptionId: 'sub_TEST1', subscriptionCancelAtPeriodEnd: false });
      expect(row.proPeriodEnd.getTime()).toBeGreaterThan(Date.now() + 25 * 86400000);
    });

    test('an Agency purchase is Agency', async () => {
      await fire('subscription.activated', { notes: { userId: user.id, plan: 'agency' } });
      expect((await reload(user)).plan).toBe('agency');
    });

    test('created and authenticated grant nothing: nobody gets access before paying', async () => {
      await fire('subscription.authenticated', { status: 'authenticated' });
      expect(await reload(user)).toMatchObject({ isPro: false, plan: 'free', subscriptionStatus: 'authenticated' });
    });

    test('a failed charge being retried (pending) keeps access and shows as past due', async () => {
      await fire('subscription.activated');
      await fire('subscription.pending', { status: 'pending' });
      expect(await reload(user)).toMatchObject({ isPro: true, subscriptionStatus: 'past_due', plan: 'studio' });
    });

    test('halted (retries used up) ends access', async () => {
      await fire('subscription.activated');
      await fire('subscription.halted', { status: 'halted' });
      expect(await reload(user)).toMatchObject({ isPro: false, plan: 'free', subscriptionStatus: 'unpaid' });
    });

    test.each(['cancelled', 'completed', 'expired'])('%s ends access and clears the cancel flag', async (status) => {
      await fire('subscription.activated');
      await prisma.user.update({ where: { id: user.id }, data: { subscriptionCancelAtPeriodEnd: true } });
      await fire(`subscription.${status}`, { status });
      expect(await reload(user)).toMatchObject({ isPro: false, plan: 'free', subscriptionStatus: 'canceled', subscriptionCancelAtPeriodEnd: false });
    });

    test('a renewal keeps a cancel-at-period-end flag until the subscription actually ends', async () => {
      await fire('subscription.activated');
      await prisma.user.update({ where: { id: user.id }, data: { subscriptionCancelAtPeriodEnd: true } });
      await fire('subscription.charged');
      expect((await reload(user)).subscriptionCancelAtPeriodEnd).toBe(true);
    });

    test('a lifetime buyer stays Pro and Agency whatever happens to a subscription', async () => {
      await prisma.user.update({ where: { id: user.id }, data: { proLifetime: true, isPro: true, plan: 'agency' } });
      await fire('subscription.cancelled', { status: 'cancelled' });
      expect(await reload(user)).toMatchObject({ isPro: true, plan: 'agency' });
    });

    test('the same event delivered twice is applied once', async () => {
      const id = eid();
      await fire('subscription.activated', {}, id);
      await prisma.user.update({ where: { id: user.id }, data: { isPro: false, plan: 'free' } });
      await fire('subscription.activated', {}, id);
      expect((await reload(user)).isPro).toBe(false); // the replay did nothing
    });

    test('with no event id the body stands in, so a replay is still caught', async () => {
      const event = eventFor(user, 'subscription.activated');
      const rawBody = Buffer.from(JSON.stringify(event));
      await razorpay.handleWebhook(event, { rawBody });
      await prisma.user.update({ where: { id: user.id }, data: { isPro: false } });
      await razorpay.handleWebhook(event, { rawBody });
      expect((await reload(user)).isPro).toBe(false);
    });

    test('a failure while applying forgets the event, so the retry is handled for real', async () => {
      const id = eid();
      const spy = jest.spyOn(prisma.user, 'update').mockRejectedValueOnce(new Error('db down'));
      await expect(fire('subscription.activated', {}, id)).rejects.toThrow('db down');
      spy.mockRestore();
      await fire('subscription.activated', {}, id);
      expect((await reload(user)).isPro).toBe(true);
    });

    test('events for someone else\'s or an unknown subscription change nothing and do not fail', async () => {
      await razorpay.handleWebhook({ event: 'subscription.activated', payload: { subscription: { entity: { id: 'sub_X', status: 'active', notes: { userId: 'nobody' } } } } }, { eventId: eid() });
      await razorpay.handleWebhook({ event: 'payment.captured', payload: {} }, { eventId: eid() });
      expect((await reload(user)).isPro).toBe(false);
    });

    test('a second paid subscription for someone already paying is cancelled, not billed twice', async () => {
      await fire('subscription.activated');
      reply({ 'POST /subscriptions/sub_ID/cancel': { id: 'sub_DUP', status: 'cancelled' } });
      await fire('subscription.activated', { id: 'sub_DUP' });
      expect(made('POST /subscriptions/sub_ID/cancel')[0].body).toEqual({ cancel_at_cycle_end: 0 });
      expect((await reload(user)).razorpaySubscriptionId).toBe('sub_TEST1');
    });
  });

  describe('sync: when the buyer comes back from paying', () => {
    test('asks Razorpay and applies the answer', async () => {
      await prisma.user.update({ where: { id: user.id }, data: { razorpaySubscriptionId: 'sub_TEST1', paymentProvider: 'razorpay' } });
      reply({ 'GET /subscriptions/sub_ID': entityFor(user) });
      expect(await razorpay.sync(user.id)).toEqual({ isPro: true, status: 'active' });
    });

    test('still unpaid stays unpaid', async () => {
      await prisma.user.update({ where: { id: user.id }, data: { razorpaySubscriptionId: 'sub_TEST1', paymentProvider: 'razorpay' } });
      reply({ 'GET /subscriptions/sub_ID': entityFor(user, { status: 'created' }) });
      expect((await razorpay.sync(user.id)).isPro).toBe(false);
    });

    test('never applies a subscription that was made for another account', async () => {
      await prisma.user.update({ where: { id: user.id }, data: { razorpaySubscriptionId: 'sub_TEST1', paymentProvider: 'razorpay' } });
      reply({ 'GET /subscriptions/sub_ID': entityFor({ id: 'someone-else' }) });
      expect((await razorpay.sync(user.id)).isPro).toBe(false);
    });

    test('with nothing to sync it just reports the current state, without calling Razorpay', async () => {
      reply({});
      expect(await razorpay.sync(user.id)).toEqual({ isPro: false, status: null });
      expect(calls).toHaveLength(0);
    });
  });

  describe('cancelling', () => {
    const subscribe = () => razorpay.handleWebhook(eventFor(user, 'subscription.activated'), { eventId: eid() });

    test('cancels at the end of the period and records it, keeping Pro on until then', async () => {
      await subscribe();
      reply({ 'POST /subscriptions/sub_ID/cancel': { id: 'sub_TEST1', status: 'active' } });
      expect(await razorpay.cancelAtPeriodEnd(user.id)).toEqual({ cancelAtPeriodEnd: true });
      expect(made('POST /subscriptions/sub_ID/cancel')[0].body).toEqual({ cancel_at_cycle_end: 1 });
      expect(await reload(user)).toMatchObject({ isPro: true, subscriptionCancelAtPeriodEnd: true });
    });

    test('cancelling twice does not call Razorpay again', async () => {
      await subscribe();
      reply({ 'POST /subscriptions/sub_ID/cancel': { id: 'sub_TEST1' } });
      await razorpay.cancelAtPeriodEnd(user.id);
      await razorpay.cancelAtPeriodEnd(user.id);
      expect(made('POST /subscriptions/sub_ID/cancel')).toHaveLength(1);
    });

    test('refused when there is no live Razorpay subscription', async () => {
      await expect(razorpay.cancelAtPeriodEnd(user.id)).rejects.toMatchObject({ statusCode: 400 });
    });

    test('if Razorpay says it can no longer be cancelled, the app re-reads it and says so', async () => {
      await subscribe();
      reply({
        'POST /subscriptions/sub_ID/cancel': { __error: 400 },
        'GET /subscriptions/sub_ID': entityFor(user, { status: 'cancelled' }),
      });
      await expect(razorpay.cancelAtPeriodEnd(user.id)).rejects.toMatchObject({ statusCode: 400 });
      expect((await reload(user)).isPro).toBe(false);
    });

    test('over HTTP: needs sign-in, and works for the signed-in buyer', async () => {
      expect((await request(app).post('/api/payments/cancel')).status).toBe(401);
      await subscribe();
      reply({ 'POST /subscriptions/sub_ID/cancel': { id: 'sub_TEST1' } });
      const res = await request(app).post('/api/payments/cancel').set('Authorization', `Bearer ${await accessTokenFor(user)}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, cancelAtPeriodEnd: true });
    });
  });

  describe('account deletion and the parts Razorpay cannot do', () => {
    test('deleting an account cancels the Razorpay subscription immediately', async () => {
      await razorpay.handleWebhook(eventFor(user, 'subscription.activated'), { eventId: eid() });
      reply({ 'POST /subscriptions/sub_ID/cancel': { id: 'sub_TEST1' } });
      await paymentService.cancelSubscriptionForUser(user.id);
      expect(made('POST /subscriptions/sub_ID/cancel')[0].body).toEqual({ cancel_at_cycle_end: 0 });
    });

    test('an already-ended subscription counts as cancelled', async () => {
      await razorpay.handleWebhook(eventFor(user, 'subscription.activated'), { eventId: eid() });
      reply({ 'POST /subscriptions/sub_ID/cancel': { __error: 400 }, 'GET /subscriptions/sub_ID': entityFor(user, { status: 'cancelled' }) });
      await expect(paymentService.cancelSubscriptionForUser(user.id)).resolves.toBeUndefined();
    });

    test('if it cannot be confirmed cancelled, deletion is refused (never leave it billing)', async () => {
      await razorpay.handleWebhook(eventFor(user, 'subscription.activated'), { eventId: eid() });
      reply({ 'POST /subscriptions/sub_ID/cancel': { __error: 500 }, 'GET /subscriptions/sub_ID': entityFor(user, { status: 'active' }) });
      await expect(paymentService.cancelSubscriptionForUser(user.id)).rejects.toMatchObject({ statusCode: 502 });
    });

    test('the Studio to Agency switch and Manage billing say plainly they are not available for Razorpay', async () => {
      await razorpay.handleWebhook(eventFor(user, 'subscription.activated'), { eventId: eid() });
      await expect(paymentService.changePlan(user.id, 'agency')).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/not available/i) });
      await expect(paymentService.createPortalSession(user.id)).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/Cancel subscription/) });
    });
  });

  describe('the options endpoint', () => {
    test('needs sign-in and says which gateway takes each currency', async () => {
      expect((await request(app).get('/api/payments/options')).status).toBe(401);
      const res = await request(app).get('/api/payments/options').set('Authorization', `Bearer ${await accessTokenFor(user)}`);
      expect(res.body).toEqual({ success: true, providers: { usd: 'stripe', inr: 'razorpay' } });
    });

    test('the secret is never returned in the profile', async () => {
      await razorpay.handleWebhook(eventFor(user, 'subscription.activated'), { eventId: eid() });
      const res = await request(app).get('/api/users/me').set('Authorization', `Bearer ${await accessTokenFor(user)}`);
      expect(JSON.stringify(res.body)).not.toContain('sub_TEST1');
      expect(JSON.stringify(res.body)).toContain('razorpay');
    });
  });
});
