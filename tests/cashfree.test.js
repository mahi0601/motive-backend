// Cashfree: INR subscriptions. The things worth pinning: the buyer's phone is required and never stored,
// amounts go out in RUPEES, the webhook is signed (HMAC of timestamp + raw body) and is only a POINTER,
// and ACCESS COMES ONLY FROM EVIDENCE OF A PAYMENT: a mandate can be ACTIVE before its first debit, so a
// status alone grants nothing; while an unreadable status or a failed read never takes access away from
// someone already paying. Cashfree is faked at `fetch`; the database is real.
jest.mock('../src/config/env', () => {
  const actual = jest.requireActual('../src/config/env');
  return {
    ...actual,
    stripe: { ...actual.stripe, secretKey: 'sk_test_fake_key_for_tests' },
    cashfree: { clientId: 'cf_client', clientSecret: 'cf_secret', mode: 'sandbox', apiVersion: '2025-01-01', maxCycles: 120 },
  };
});

const crypto = require('crypto');
const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/prisma');
const config = require('../src/config/env');
const cashfree = require('../src/services/cashfree.service');
const paymentService = require('../src/services/payment.service');
const { accessTokenFor, makeUser, cleanupUsers } = require('./helpers/fixtures');

const calls = [];
const reply = (routes) => {
  global.fetch = jest.fn(async (url, init = {}) => {
    const path = String(url).replace('https://sandbox.cashfree.com', '');
    const key = `${init.method || 'GET'} ${path.replace(/\/pg\/subscriptions\/[^/?]+/, '/pg/subscriptions/ID')}`;
    calls.push({ key, json: init.body ? JSON.parse(init.body) : undefined, headers: init.headers });
    const hit = routes[key];
    if (hit === undefined) return { ok: false, status: 404, json: async () => ({ code: 'not_found' }) };
    const out = typeof hit === 'function' ? hit() : hit;
    if (out && out.__error) return { ok: false, status: out.__error, json: async () => ({ code: 'err', message: 'secret detail' }) };
    return { ok: true, status: 200, json: async () => out };
  });
};
const made = (key) => calls.filter((c) => c.key === key);

const SUB = 'cg_test_sub1';
const entityFor = (user, over = {}) => ({
  subscription_id: SUB, cf_subscription_id: 'cf1', subscription_status: 'ACTIVE', subscription_tags: { userId: user.id, plan: 'studio' },
  next_schedule_date: new Date(Date.now() + 30 * 86400000).toISOString(), ...over,
});
const sign = (ts, raw, secret = config.cashfree.clientSecret) => crypto.createHmac('sha256', secret).update(ts + raw).digest('base64');
const reload = (user) => prisma.user.findUnique({ where: { id: user.id }, omit: { cashfreeSubscriptionId: false } });
let seq = 0;
const event = (type, data = { subscription_details: { subscription_id: SUB } }) => ({ type, data, _n: seq++ });
const PAID_LIST = [{ payment_status: 'SUCCESS' }];

describe('cashfree', () => {
  let user;
  beforeEach(async () => {
    calls.length = 0;
    // Some tests deliver the same message twice using a fixed timestamp and body, so the ledger of
    // processed messages is emptied first: rows left by an earlier run would look like "already done".
    await prisma.webhookEvent.deleteMany({ where: { stripeEventId: { startsWith: 'cashfree:' } } });
    user = await makeUser('cf');
  });
  afterEach(async () => {
    await cleanupUsers(user);
    jest.restoreAllMocks();
  });
  afterAll(async () => prisma.$disconnect());

  describe('phone numbers', () => {
    test.each([
      ['9876543210', '9876543210'],
      ['98765 43210', '9876543210'],
      ['+91 98765-43210', '9876543210'],
      ['919876543210', '9876543210'],
      ['09876543210', '9876543210'],
      ['6000000000', '6000000000'],
    ])('%s is accepted as %s', (input, out) => expect(cashfree.normalizePhone(input)).toBe(out));

    test.each([['5876543210'], ['98765'], ['98765432101'], ['abcdefghij'], [''], [undefined], [9876543210], [{}]])('%p is refused', (input) => {
      expect(cashfree.normalizePhone(input)).toBeNull();
    });
  });

  describe('starting a checkout', () => {
    const ok = () => reply({ 'POST /pg/subscriptions': { cf_subscription_id: 'cf1', subscription_status: 'INITIALIZED', subscription_session_id: 'session_abc' } });

    test('sends rupees (not paise), an inline monthly plan, the buyer and tags, and returns the session for the SDK', async () => {
      ok();
      const res = await paymentService.createCheckoutSession(user, 'inr', 'studio', { provider: 'cashfree', phone: '98765 43210' });
      expect(res).toEqual({ provider: 'cashfree', sessionId: 'session_abc', mode: 'sandbox' });
      const body = made('POST /pg/subscriptions')[0].json;
      expect(body.plan_details).toMatchObject({
        plan_type: 'PERIODIC', plan_currency: 'INR', plan_interval_type: 'MONTH', plan_intervals: 1, plan_max_cycles: 120,
        plan_amount: config.stripe.plans.studio.inr.amount / 100, plan_max_amount: config.stripe.plans.studio.inr.amount / 100,
      });
      expect(body.plan_details.plan_name.length).toBeLessThanOrEqual(40);
      expect(body.customer_details).toMatchObject({ customer_email: user.email, customer_phone: '9876543210' });
      expect(body.subscription_tags).toEqual({ userId: user.id, plan: 'studio' });
      expect(body.subscription_meta.return_url).toBe(`${config.frontendUrl}/settings?upgrade=pending&gateway=cashfree`);
      expect(body.subscription_id).toMatch(/^cg_[A-Za-z0-9_.-]+$/);
      expect(body.subscription_id.length).toBeLessThanOrEqual(250);
    });

    test('authenticates with the client id, secret and API version', async () => {
      ok();
      await cashfree.createCheckout(user, 'studio', 'inr', { phone: '9876543210' });
      expect(made('POST /pg/subscriptions')[0].headers).toMatchObject({ 'x-client-id': 'cf_client', 'x-client-secret': 'cf_secret', 'x-api-version': '2025-01-01' });
    });

    test('remembers the subscription id but grants nothing until it is paid', async () => {
      ok();
      await cashfree.createCheckout(user, 'studio', 'inr', { phone: '9876543210' });
      const row = await reload(user);
      expect(row).toMatchObject({ paymentProvider: 'cashfree', isPro: false, plan: 'free' });
      expect(row.cashfreeSubscriptionId).toMatch(/^cg_/);
    });

    test('the phone number is passed on and never stored anywhere on the user', async () => {
      ok();
      await cashfree.createCheckout(user, 'studio', 'inr', { phone: '9876543210' });
      expect(JSON.stringify(await reload(user))).not.toContain('9876543210');
    });

    test.each([['no phone', {}], ['a bad phone', { phone: '12345' }]])('%s is a 400 and nothing is sent to Cashfree', async (_l, extras) => {
      ok();
      await expect(cashfree.createCheckout(user, 'studio', 'inr', extras)).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/10-digit/) });
      expect(calls).toHaveLength(0);
    });

    test.each([
      ['USD (Cashfree takes INR only)', () => cashfree.createCheckout(user, 'studio', 'usd', { phone: '9876543210' })],
      ['an unknown plan', () => cashfree.createCheckout(user, 'platinum', 'inr', { phone: '9876543210' })],
      ['someone already Pro', () => cashfree.createCheckout({ ...user, isPro: true }, 'studio', 'inr', { phone: '9876543210' })],
    ])('refuses %s with a 400', async (_l, run) => {
      ok();
      await expect(run()).rejects.toMatchObject({ statusCode: 400 });
      expect(calls).toHaveLength(0);
    });

    test('a response with no session id is a 502', async () => {
      reply({ 'POST /pg/subscriptions': { subscription_status: 'INITIALIZED' } });
      await expect(cashfree.createCheckout(user, 'studio', 'inr', { phone: '9876543210' })).rejects.toMatchObject({ statusCode: 502 });
      expect((await reload(user)).cashfreeSubscriptionId).toBeNull();
    });

    test('a Cashfree error is a 502 with a plain message that does not repeat what Cashfree said', async () => {
      reply({ 'POST /pg/subscriptions': { __error: 422 } });
      const err = await cashfree.createCheckout(user, 'studio', 'inr', { phone: '9876543210' }).catch((e) => e);
      expect(err.statusCode).toBe(502);
      expect(err.message).not.toMatch(/secret detail/);
    });

    test('with no keys it is a 503', async () => {
      const saved = { ...config.cashfree };
      Object.assign(config.cashfree, { clientId: '', clientSecret: '' });
      try {
        await expect(cashfree.createCheckout(user, 'studio', 'inr', { phone: '9876543210' })).rejects.toMatchObject({ statusCode: 503 });
      } finally {
        Object.assign(config.cashfree, saved);
      }
    });
  });

  describe('the webhook signature', () => {
    const body = JSON.stringify(event('SUBSCRIPTION_STATUS_CHANGED'));
    const now = () => String(Date.now());

    test('HMAC-SHA256 of timestamp + raw body, base64, is accepted and parsed', () => {
      const ts = now();
      expect(cashfree.verifyWebhook(Buffer.from(body), sign(ts, body), ts).type).toBe('SUBSCRIPTION_STATUS_CHANGED');
    });

    test.each([
      ['a wrong signature', (ts) => sign(ts, 'other body')],
      ['one made with another secret', (ts) => sign(ts, body, 'not-the-secret')],
      ['one that ignores the timestamp', () => crypto.createHmac('sha256', 'cf_secret').update(body).digest('base64')],
      ['an empty signature', () => ''],
      ['a shorter signature', () => 'abc'],
    ])('rejects %s', (_l, make) => {
      const ts = now();
      expect(() => cashfree.verifyWebhook(Buffer.from(body), make(ts), ts)).toThrow();
    });

    test('rejects a missing signature or timestamp', () => {
      const ts = now();
      expect(() => cashfree.verifyWebhook(Buffer.from(body), undefined, ts)).toThrow(/Missing/);
      expect(() => cashfree.verifyWebhook(Buffer.from(body), sign(ts, body), undefined)).toThrow(/Missing/);
    });

    test('a body changed after signing is rejected', () => {
      const ts = now();
      expect(() => cashfree.verifyWebhook(Buffer.from(body.replace('STATUS', 'PAYMENT')), sign(ts, body), ts)).toThrow();
    });

    test('a genuine but old message (over ten minutes) is rejected as a replay, in milliseconds or seconds', () => {
      const oldMs = String(Date.now() - 11 * 60 * 1000);
      expect(() => cashfree.verifyWebhook(Buffer.from(body), sign(oldMs, body), oldMs)).toThrow(/Stale/);
      const oldSeconds = String(Math.floor(Date.now() / 1000) - 11 * 60);
      expect(() => cashfree.verifyWebhook(Buffer.from(body), sign(oldSeconds, body), oldSeconds)).toThrow(/Stale/);
      const recentSeconds = String(Math.floor(Date.now() / 1000) - 60);
      expect(cashfree.verifyWebhook(Buffer.from(body), sign(recentSeconds, body), recentSeconds)).toBeTruthy();
    });

    test('a timestamp that is not a number is accepted on a good signature (it cannot be age-checked)', () => {
      const ts = '2026-10-04T10:00:00Z';
      expect(cashfree.verifyWebhook(Buffer.from(body), sign(ts, body), ts)).toBeTruthy();
    });

    test('with no secret configured it refuses everything', () => {
      const saved = config.cashfree.clientSecret;
      config.cashfree.clientSecret = '';
      try {
        expect(() => cashfree.verifyWebhook(Buffer.from(body), 'x', now())).toThrow(/not configured/);
      } finally {
        config.cashfree.clientSecret = saved;
      }
    });

    test('over HTTP: a good signature gets 200 and acts; a bad one gets 400 and changes nothing', async () => {
      const payload = JSON.stringify(event('SUBSCRIPTION_PAYMENT_SUCCESS'));
      const bad = await request(app).post('/api/payments/cashfree/webhook').set('Content-Type', 'application/json').set('x-webhook-timestamp', now()).set('x-webhook-signature', 'nope').send(payload);
      expect(bad.status).toBe(400);
      await prisma.user.update({ where: { id: user.id }, data: { cashfreeSubscriptionId: SUB, paymentProvider: 'cashfree' } });
      reply({ 'GET /pg/subscriptions/ID': entityFor(user) });
      const ts = now();
      const good = await request(app).post('/api/payments/cashfree/webhook').set('Content-Type', 'application/json').set('x-webhook-timestamp', ts).set('x-webhook-signature', sign(ts, payload)).send(payload);
      expect(good.status).toBe(200);
      expect((await reload(user)).isPro).toBe(true);
    });
  });

  describe('what a webhook does: a pointer, and access only on evidence of payment', () => {
    const fire = (ev, { entity = entityFor(user), payments = [] } = {}) => {
      reply({ 'GET /pg/subscriptions/ID': entity, 'GET /pg/subscriptions/ID/payments': payments });
      return cashfree.handleWebhook(ev, { timestamp: String(Date.now()), rawBody: Buffer.from(JSON.stringify(ev)) });
    };
    beforeEach(async () => {
      await prisma.user.update({ where: { id: user.id }, data: { cashfreeSubscriptionId: SUB, paymentProvider: 'cashfree' } });
    });

    test('a signed payment-success event grants the plan from the tags, with the period end from next_schedule_date', async () => {
      await fire(event('SUBSCRIPTION_PAYMENT_SUCCESS'));
      const row = await reload(user);
      expect(row).toMatchObject({ isPro: true, plan: 'studio', subscriptionStatus: 'active', paymentProvider: 'cashfree', subscriptionCancelAtPeriodEnd: false });
      expect(row.proPeriodEnd.getTime()).toBeGreaterThan(Date.now() + 25 * 86400000);
    });

    test('ACTIVE alone (mandate approved, no payment yet) grants nothing', async () => {
      await fire(event('SUBSCRIPTION_STATUS_CHANGED'), { payments: [] });
      expect(await reload(user)).toMatchObject({ isPro: false, plan: 'free', subscriptionStatus: 'incomplete' });
    });

    test('ACTIVE with a successful payment on the list grants it (a status change delivered after the payment)', async () => {
      await fire(event('SUBSCRIPTION_STATUS_CHANGED'), { payments: PAID_LIST });
      expect((await reload(user)).isPro).toBe(true);
    });

    test('a payment list in another shape ({ data: [...] }) is understood too', async () => {
      await fire(event('SUBSCRIPTION_STATUS_CHANGED'), { payments: { data: PAID_LIST } });
      expect((await reload(user)).isPro).toBe(true);
    });

    test('a failed payments read or an unreadable list is "no evidence": nothing is granted', async () => {
      reply({ 'GET /pg/subscriptions/ID': entityFor(user), 'GET /pg/subscriptions/ID/payments': { __error: 500 } });
      await cashfree.handleWebhook(event('SUBSCRIPTION_STATUS_CHANGED'), { timestamp: '1', rawBody: Buffer.from('a') });
      expect((await reload(user)).isPro).toBe(false);
      await fire(event('SUBSCRIPTION_STATUS_CHANGED'), { payments: 'what' });
      expect((await reload(user)).isPro).toBe(false);
    });

    test('a failed payment on the list does not count as paid', async () => {
      await fire(event('SUBSCRIPTION_STATUS_CHANGED'), { payments: [{ payment_status: 'FAILED' }, { payment_status: 'PENDING' }] });
      expect((await reload(user)).isPro).toBe(false);
    });

    test('once paying, a later status event whose payments read fails does NOT revoke access', async () => {
      await fire(event('SUBSCRIPTION_PAYMENT_SUCCESS'));
      reply({ 'GET /pg/subscriptions/ID': entityFor(user), 'GET /pg/subscriptions/ID/payments': { __error: 500 } });
      await cashfree.handleWebhook(event('SUBSCRIPTION_STATUS_CHANGED'), { timestamp: '2', rawBody: Buffer.from('b') });
      expect(await reload(user)).toMatchObject({ isPro: true, subscriptionStatus: 'active' });
    });

    test('a status Cashfree adds later never cuts off someone already paying, and grants nobody else access', async () => {
      await fire(event('SUBSCRIPTION_PAYMENT_SUCCESS'));
      await fire(event('SUBSCRIPTION_STATUS_CHANGED'), { entity: entityFor(user, { subscription_status: 'SOME_NEW_STATUS' }) });
      expect(await reload(user)).toMatchObject({ isPro: true });
      const other = await makeUser('cf2');
      try {
        await prisma.user.update({ where: { id: other.id }, data: { cashfreeSubscriptionId: 'cg_other', paymentProvider: 'cashfree' } });
        reply({ 'GET /pg/subscriptions/ID': { ...entityFor(other, { subscription_id: 'cg_other', subscription_status: 'SOME_NEW_STATUS' }) } });
        await cashfree.handleWebhook(event('SUBSCRIPTION_STATUS_CHANGED', { subscription_details: { subscription_id: 'cg_other' } }), { timestamp: '3', rawBody: Buffer.from('c') });
        expect((await prisma.user.findUnique({ where: { id: other.id } })).isPro).toBe(false);
      } finally {
        await cleanupUsers(other);
      }
    });

    test('a failed charge keeps access and shows as past due', async () => {
      await fire(event('SUBSCRIPTION_PAYMENT_SUCCESS'));
      await fire(event('SUBSCRIPTION_PAYMENT_FAILED'));
      expect(await reload(user)).toMatchObject({ isPro: true, subscriptionStatus: 'past_due' });
    });

    test.each([['HALTED', 'unpaid'], ['FAILED', 'unpaid'], ['CANCELLED', 'canceled'], ['COMPLETED', 'canceled']])('%s ends access', async (status, stored) => {
      await fire(event('SUBSCRIPTION_PAYMENT_SUCCESS'));
      await fire(event('SUBSCRIPTION_STATUS_CHANGED'), { entity: entityFor(user, { subscription_status: status }) });
      expect(await reload(user)).toMatchObject({ isPro: false, plan: 'free', subscriptionStatus: stored });
    });

    test.each([['INITIALIZED'], ['BANK_APPROVAL_PENDING']])('%s grants nothing', async (status) => {
      await fire(event('SUBSCRIPTION_AUTH_STATUS'), { entity: entityFor(user, { subscription_status: status }) });
      expect(await reload(user)).toMatchObject({ isPro: false, subscriptionStatus: 'incomplete' });
    });

    test('PAUSED is not an ended subscription but carries no access', async () => {
      await fire(event('SUBSCRIPTION_PAYMENT_SUCCESS'));
      await fire(event('SUBSCRIPTION_STATUS_CHANGED'), { entity: entityFor(user, { subscription_status: 'PAUSED' }) });
      expect(await reload(user)).toMatchObject({ isPro: false, subscriptionStatus: 'paused' });
    });

    test('a lifetime buyer stays Pro and Agency whatever happens to a subscription', async () => {
      await prisma.user.update({ where: { id: user.id }, data: { proLifetime: true, isPro: true, plan: 'agency' } });
      await fire(event('SUBSCRIPTION_STATUS_CHANGED'), { entity: entityFor(user, { subscription_status: 'CANCELLED' }) });
      expect(await reload(user)).toMatchObject({ isPro: true, plan: 'agency' });
    });

    test('the subscription id is found whether it sits in subscription_details or beside the payment', async () => {
      await fire(event('SUBSCRIPTION_PAYMENT_SUCCESS', { subscription_id: SUB, payment_status: 'SUCCESS' }));
      expect((await reload(user)).isPro).toBe(true);
    });

    test('the same message delivered twice is applied once', async () => {
      const ev = event('SUBSCRIPTION_PAYMENT_SUCCESS');
      reply({ 'GET /pg/subscriptions/ID': entityFor(user) });
      const opts = { timestamp: '1700000000000', rawBody: Buffer.from(JSON.stringify(ev)) };
      await cashfree.handleWebhook(ev, opts);
      await prisma.user.update({ where: { id: user.id }, data: { isPro: false, plan: 'free' } });
      await cashfree.handleWebhook(ev, opts);
      expect((await reload(user)).isPro).toBe(false);
      expect(made('GET /pg/subscriptions/ID')).toHaveLength(1);
    });

    test('a failure while applying forgets the message, so Cashfree\'s retry is handled for real', async () => {
      const ev = event('SUBSCRIPTION_PAYMENT_SUCCESS');
      const opts = { timestamp: '1700000000001', rawBody: Buffer.from(JSON.stringify(ev)) };
      reply({ 'GET /pg/subscriptions/ID': { __error: 500 } });
      await expect(cashfree.handleWebhook(ev, opts)).rejects.toMatchObject({ statusCode: 502 });
      reply({ 'GET /pg/subscriptions/ID': entityFor(user) });
      await cashfree.handleWebhook(ev, opts);
      expect((await reload(user)).isPro).toBe(true);
    });

    test('events that are not about a subscription are ignored without calling Cashfree', async () => {
      reply({});
      await cashfree.handleWebhook({ type: 'PAYMENT_SUCCESS_WEBHOOK', data: { order: { order_id: 'o1' } } }, { timestamp: '5', rawBody: Buffer.from('z') });
      expect(calls).toHaveLength(0);
    });

    test('a second paid subscription for someone already paying is cancelled, not billed twice', async () => {
      await fire(event('SUBSCRIPTION_PAYMENT_SUCCESS'));
      reply({ 'GET /pg/subscriptions/ID': entityFor(user, { subscription_id: 'cg_dup' }), 'POST /pg/subscriptions/ID/manage': { subscription_status: 'CANCELLED' } });
      await cashfree.handleWebhook(event('SUBSCRIPTION_PAYMENT_SUCCESS', { subscription_details: { subscription_id: 'cg_dup' } }), { timestamp: '9', rawBody: Buffer.from('dup') });
      expect(made('POST /pg/subscriptions/ID/manage')[0].json).toEqual({ subscription_id: 'cg_dup', action: 'CANCEL' });
      expect((await reload(user)).cashfreeSubscriptionId).toBe(SUB);
    });
  });

  describe('sync: when the buyer comes back from Cashfree', () => {
    beforeEach(async () => {
      await prisma.user.update({ where: { id: user.id }, data: { cashfreeSubscriptionId: SUB, paymentProvider: 'cashfree' } });
    });

    test('with a successful payment on record it applies the subscription', async () => {
      reply({ 'GET /pg/subscriptions/ID': entityFor(user), 'GET /pg/subscriptions/ID/payments': PAID_LIST });
      expect(await paymentService.syncForUser(user.id)).toEqual({ isPro: true, status: 'active' });
    });

    test('with no payment yet it stays unpaid', async () => {
      reply({ 'GET /pg/subscriptions/ID': entityFor(user), 'GET /pg/subscriptions/ID/payments': [] });
      expect((await cashfree.sync(user.id)).isPro).toBe(false);
    });

    test('never applies a subscription that was made for another account', async () => {
      reply({ 'GET /pg/subscriptions/ID': entityFor({ id: 'someone-else' }), 'GET /pg/subscriptions/ID/payments': PAID_LIST });
      expect((await cashfree.sync(user.id)).isPro).toBe(false);
    });

    test('with nothing to sync it reports the stored state without calling Cashfree', async () => {
      await prisma.user.update({ where: { id: user.id }, data: { cashfreeSubscriptionId: null } });
      reply({});
      expect(await cashfree.sync(user.id)).toEqual({ isPro: false, status: null });
      expect(calls).toHaveLength(0);
    });
  });

  describe('cancelling', () => {
    const subscribe = async () => {
      await prisma.user.update({ where: { id: user.id }, data: { cashfreeSubscriptionId: SUB, paymentProvider: 'cashfree' } });
      reply({ 'GET /pg/subscriptions/ID': entityFor(user) });
      await cashfree.handleWebhook(event('SUBSCRIPTION_PAYMENT_SUCCESS'), { timestamp: String(Date.now()), rawBody: Buffer.from(`s${seq}`) });
    };

    test('stops billing, records the cancel and keeps Pro on until the paid-until date', async () => {
      await subscribe();
      const end = new Date(Date.now() + 12 * 86400000).toISOString();
      reply({ 'GET /pg/subscriptions/ID': entityFor(user, { next_schedule_date: end }), 'POST /pg/subscriptions/ID/manage': { subscription_status: 'CANCELLED' } });
      expect(await paymentService.cancelForUser(user.id)).toEqual({ cancelAtPeriodEnd: true });
      expect(made('POST /pg/subscriptions/ID/manage')[0].json).toEqual({ subscription_id: SUB, action: 'CANCEL' });
      const row = await reload(user);
      expect(row).toMatchObject({ isPro: true, subscriptionCancelAtPeriodEnd: true });
      expect(row.proPeriodEnd.toISOString()).toBe(end);
    });

    test('Cashfree\'s CANCELLED status after that does not take access away before the date', async () => {
      await subscribe();
      reply({ 'GET /pg/subscriptions/ID': entityFor(user), 'POST /pg/subscriptions/ID/manage': {} });
      await cashfree.cancelAtPeriodEnd(user.id);
      reply({ 'GET /pg/subscriptions/ID': entityFor(user, { subscription_status: 'CANCELLED', next_schedule_date: null }) });
      await cashfree.handleWebhook(event('SUBSCRIPTION_STATUS_CHANGED'), { timestamp: '77', rawBody: Buffer.from('x77') });
      expect(await reload(user)).toMatchObject({ isPro: true, plan: 'studio', subscriptionCancelAtPeriodEnd: true });
    });

    test('cancelling twice does not call Cashfree again', async () => {
      await subscribe();
      reply({ 'GET /pg/subscriptions/ID': entityFor(user), 'POST /pg/subscriptions/ID/manage': {} });
      await cashfree.cancelAtPeriodEnd(user.id);
      await cashfree.cancelAtPeriodEnd(user.id);
      expect(made('POST /pg/subscriptions/ID/manage')).toHaveLength(1);
    });

    test('refused when there is no live Cashfree subscription', async () => {
      await expect(cashfree.cancelAtPeriodEnd(user.id)).rejects.toMatchObject({ statusCode: 400 });
    });

    test('if Cashfree refuses, the app re-reads and says it can no longer be cancelled', async () => {
      await subscribe();
      reply({ 'POST /pg/subscriptions/ID/manage': { __error: 422 }, 'GET /pg/subscriptions/ID': entityFor(user, { subscription_status: 'HALTED' }) });
      await expect(cashfree.cancelAtPeriodEnd(user.id)).rejects.toMatchObject({ statusCode: 400 });
      expect((await reload(user)).isPro).toBe(false);
    });

    test('over HTTP: needs sign-in, and works for the signed-in buyer', async () => {
      expect((await request(app).post('/api/payments/cancel')).status).toBe(401);
      await subscribe();
      reply({ 'GET /pg/subscriptions/ID': entityFor(user), 'POST /pg/subscriptions/ID/manage': {} });
      const res = await request(app).post('/api/payments/cancel').set('Authorization', `Bearer ${await accessTokenFor(user)}`);
      expect(res.body).toMatchObject({ success: true, cancelAtPeriodEnd: true });
    });
  });

  describe('account deletion and the parts Cashfree cannot do', () => {
    const subscribe = async () => {
      await prisma.user.update({ where: { id: user.id }, data: { cashfreeSubscriptionId: SUB, paymentProvider: 'cashfree' } });
      reply({ 'GET /pg/subscriptions/ID': entityFor(user) });
      await cashfree.handleWebhook(event('SUBSCRIPTION_PAYMENT_SUCCESS'), { timestamp: String(Date.now()), rawBody: Buffer.from(`d${seq}`) });
    };

    test('deleting an account cancels the Cashfree subscription', async () => {
      await subscribe();
      reply({ 'POST /pg/subscriptions/ID/manage': {} });
      await paymentService.cancelSubscriptionForUser(user.id);
      expect(made('POST /pg/subscriptions/ID/manage')).toHaveLength(1);
    });

    test.each([['CANCELLED'], ['COMPLETED'], ['INITIALIZED']])('a %s subscription needs nothing more, so deletion goes ahead', async (status) => {
      await subscribe();
      reply({ 'POST /pg/subscriptions/ID/manage': { __error: 422 }, 'GET /pg/subscriptions/ID': entityFor(user, { subscription_status: status }) });
      await expect(paymentService.cancelSubscriptionForUser(user.id)).resolves.toBeUndefined();
    });

    test.each([['ACTIVE'], ['PAUSED']])('if a %s subscription cannot be cancelled, deletion is refused (never leave it billing)', async (status) => {
      await subscribe();
      reply({ 'POST /pg/subscriptions/ID/manage': { __error: 500 }, 'GET /pg/subscriptions/ID': entityFor(user, { subscription_status: status }) });
      await expect(paymentService.cancelSubscriptionForUser(user.id)).rejects.toMatchObject({ statusCode: 502 });
    });

    test('the Studio to Agency switch and Manage billing say plainly they are not available', async () => {
      await subscribe();
      await expect(paymentService.changePlan(user.id, 'agency')).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/not available/i) });
      await expect(paymentService.createPortalSession(user.id)).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/Cancel subscription/) });
    });

    test('the subscription id is never returned in the profile', async () => {
      await subscribe();
      const res = await request(app).get('/api/users/me').set('Authorization', `Bearer ${await accessTokenFor(user)}`);
      expect(JSON.stringify(res.body)).not.toContain(SUB);
      expect(JSON.stringify(res.body)).toContain('cashfree');
    });
  });
});
