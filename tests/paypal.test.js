// PayPal: USD subscriptions. Real-money logic, so the tests pin what matters: the token is reused, the
// product and plan are created once, a double-click cannot start two subscriptions, a webhook is
// verified by PayPal and is only a POINTER (the subscription is re-read, the payload is never
// trusted), nobody gets access before paying, a cancel keeps access to the paid-until date, and
// account deletion refuses to leave a subscription billing. PayPal is faked at `fetch`.
jest.mock('../src/config/env', () => {
  const actual = jest.requireActual('../src/config/env');
  return {
    ...actual,
    stripe: { ...actual.stripe, secretKey: 'sk_test_fake_key_for_tests' },
    paypal: { clientId: 'pp_client', clientSecret: 'pp_secret', webhookId: 'WH-TEST-1', mode: 'sandbox' },
  };
});

const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/prisma');
const config = require('../src/config/env');
const paypal = require('../src/services/paypal.service');
const paymentService = require('../src/services/payment.service');
const { accessTokenFor, makeUser, cleanupUsers } = require('./helpers/fixtures');

const calls = [];
const reply = (routes) => {
  global.fetch = jest.fn(async (url, init = {}) => {
    const path = String(url).replace('https://api-m.sandbox.paypal.com', '');
    const key = `${init.method || 'GET'} ${path.replace(/\/subscriptions\/[^/?]+/, '/subscriptions/ID')}`;
    calls.push({ key, body: init.body, json: init.body && init.body.startsWith('{') ? JSON.parse(init.body) : undefined, headers: init.headers });
    const hit = routes[key];
    if (hit === undefined) return { ok: false, status: 404, json: async () => ({ name: 'NOT_FOUND' }) };
    const out = typeof hit === 'function' ? hit() : hit;
    if (out && out.__error) return { ok: false, status: out.__error, json: async () => ({ name: out.name || 'ERR', message: 'secret detail' }) };
    if (out === 204) return { ok: true, status: 204, json: async () => { throw new Error('no body'); } };
    return { ok: true, status: 200, json: async () => out };
  });
};
const made = (key) => calls.filter((c) => c.key === key);
const TOKEN = { 'POST /v1/oauth2/token': { access_token: 'tok_1', expires_in: 3600 } };

const entityFor = (user, over = {}) => ({
  id: 'I-TEST1', status: 'ACTIVE', plan_id: 'P-STUDIO', custom_id: user.id,
  billing_info: { next_billing_time: new Date(Date.now() + 30 * 86400000).toISOString(), failed_payments_count: 0 }, ...over,
});
const reload = (user) => prisma.user.findUnique({ where: { id: user.id }, omit: { paypalSubscriptionId: false } });
let seq = 0;
const evt = (type, resource = { id: 'I-TEST1' }, id = `WH-${Date.now()}-${seq++}`) => ({ id, event_type: type, resource });

describe('paypal', () => {
  let user;
  beforeEach(async () => {
    calls.length = 0;
    paypal._resetToken();
    await prisma.providerPlan.deleteMany({});
    await prisma.providerPlan.create({ data: { provider: 'paypal', plan: 'studio', currency: 'usd', amount: config.stripe.plans.studio.usd.amount, providerPlanId: 'P-STUDIO' } });
    user = await makeUser('pp');
  });
  afterEach(async () => {
    await cleanupUsers(user);
    jest.restoreAllMocks();
  });
  afterAll(async () => {
    await prisma.providerPlan.deleteMany({});
    await prisma.$disconnect();
  });

  describe('starting a checkout', () => {
    const fresh = async () => {
      await prisma.providerPlan.deleteMany({});
      reply({
        ...TOKEN,
        'POST /v1/catalogs/products': { id: 'PROD-1' },
        'POST /v1/billing/plans': { id: 'P-NEW1' },
        'POST /v1/billing/subscriptions': { id: 'I-NEW1', status: 'APPROVAL_PENDING', links: [{ rel: 'self', href: 'https://x/self' }, { rel: 'approve', href: 'https://www.sandbox.paypal.com/approve/I-NEW1' }] },
      });
    };

    test('creates the product and plan once, then the subscription, and returns the approval link', async () => {
      await fresh();
      const res = await paymentService.createCheckoutSession(user, 'usd', 'studio', { provider: 'paypal' });
      expect(res).toEqual({ provider: 'paypal', url: 'https://www.sandbox.paypal.com/approve/I-NEW1' });
      expect(made('POST /v1/catalogs/products')).toHaveLength(1);
      const plan = made('POST /v1/billing/plans')[0].json;
      expect(plan.product_id).toBe('PROD-1');
      expect(plan.billing_cycles[0]).toMatchObject({
        frequency: { interval_unit: 'MONTH', interval_count: 1 },
        total_cycles: 0,
        pricing_scheme: { fixed_price: { value: (config.stripe.plans.studio.usd.amount / 100).toFixed(2), currency_code: 'USD' } },
      });
      const sub = made('POST /v1/billing/subscriptions')[0];
      expect(sub.json).toMatchObject({ plan_id: 'P-NEW1', custom_id: user.id });
      expect(sub.json.application_context.return_url).toBe(`${config.frontendUrl}/settings?upgrade=pending&gateway=paypal`);
      expect(sub.json.application_context.cancel_url).toContain('upgrade=cancelled');
    });

    test('the token is fetched once and reused, with the client id and secret as Basic auth', async () => {
      await fresh();
      await paymentService.createCheckoutSession(user, 'usd', 'studio', { provider: 'paypal' });
      await paymentService.createCheckoutSession(user, 'usd', 'studio', { provider: 'paypal' });
      const tokenCalls = made('POST /v1/oauth2/token');
      expect(tokenCalls).toHaveLength(1);
      expect(tokenCalls[0].headers.Authorization).toBe(`Basic ${Buffer.from('pp_client:pp_secret').toString('base64')}`);
      expect(tokenCalls[0].body).toBe('grant_type=client_credentials');
      expect(made('POST /v1/billing/subscriptions')[0].headers.Authorization).toBe('Bearer tok_1');
    });

    test('an expired token is replaced', async () => {
      reply({ 'POST /v1/oauth2/token': { access_token: 'short', expires_in: 30 }, 'POST /v1/billing/subscriptions': { id: 'I-A', links: [{ rel: 'approve', href: 'https://x/a' }] } });
      await paypal.createCheckout(user, 'studio');
      await paypal.createCheckout(user, 'studio');
      expect(made('POST /v1/oauth2/token')).toHaveLength(2); // 30s is inside the one-minute safety margin
    });

    test('a known plan is reused: no product or plan calls', async () => {
      reply({ ...TOKEN, 'POST /v1/billing/subscriptions': { id: 'I-NEW2', links: [{ rel: 'approve', href: 'https://x/ok' }] } });
      await paypal.createCheckout(user, 'studio');
      expect(made('POST /v1/catalogs/products')).toHaveLength(0);
      expect(made('POST /v1/billing/plans')).toHaveLength(0);
      expect(made('POST /v1/billing/subscriptions')[0].json.plan_id).toBe('P-STUDIO');
    });

    test('the request id repeats for the same buyer, plan and price within a window, so a double-click is one subscription', async () => {
      reply({ ...TOKEN, 'POST /v1/billing/subscriptions': { id: 'I-NEW3', links: [{ rel: 'approve', href: 'https://x/ok' }] } });
      await paypal.createCheckout(user, 'studio');
      await paypal.createCheckout(user, 'studio');
      const ids = made('POST /v1/billing/subscriptions').map((c) => c.headers['PayPal-Request-Id']);
      expect(ids[0]).toBe(ids[1]);
      expect(ids[0]).toContain(user.id);
    });

    test('remembers the subscription id but grants nothing until it is paid', async () => {
      reply({ ...TOKEN, 'POST /v1/billing/subscriptions': { id: 'I-NEW4', links: [{ rel: 'approve', href: 'https://x/ok' }] } });
      await paypal.createCheckout(user, 'studio');
      expect(await reload(user)).toMatchObject({ paypalSubscriptionId: 'I-NEW4', paymentProvider: 'paypal', isPro: false, plan: 'free' });
    });

    test.each([
      ['INR (PayPal takes USD only)', () => paypal.createCheckout(user, 'studio', 'inr')],
      ['an unknown plan', () => paypal.createCheckout(user, 'platinum')],
      ['someone already Pro', () => paypal.createCheckout({ ...user, isPro: true }, 'studio')],
    ])('refuses %s with a 400', async (_l, run) => {
      reply({ ...TOKEN });
      await expect(run()).rejects.toMatchObject({ statusCode: 400 });
      expect(made('POST /v1/billing/subscriptions')).toHaveLength(0);
    });

    test('a response with no approval link is a 502', async () => {
      reply({ ...TOKEN, 'POST /v1/billing/subscriptions': { id: 'I-NEW5', links: [] } });
      await expect(paypal.createCheckout(user, 'studio')).rejects.toMatchObject({ statusCode: 502 });
    });

    test('a PayPal error is a 502 with a plain message that does not repeat what PayPal said', async () => {
      reply({ ...TOKEN, 'POST /v1/billing/subscriptions': { __error: 422, name: 'UNPROCESSABLE_ENTITY' } });
      const err = await paypal.createCheckout(user, 'studio').catch((e) => e);
      expect(err.statusCode).toBe(502);
      expect(err.message).not.toMatch(/secret detail/);
    });

    test('rejected keys (no access token) are a 502, not a crash', async () => {
      reply({ 'POST /v1/oauth2/token': { __error: 401, name: 'invalid_client' } });
      await expect(paypal.createCheckout(user, 'studio')).rejects.toMatchObject({ statusCode: 502 });
    });

    test('with no keys it is a 503', async () => {
      const saved = { ...config.paypal };
      Object.assign(config.paypal, { clientId: '', clientSecret: '' });
      try {
        await expect(paypal.createCheckout(user, 'studio')).rejects.toMatchObject({ statusCode: 503 });
      } finally {
        Object.assign(config.paypal, saved);
      }
    });
  });

  describe('verifying a webhook', () => {
    const headers = { 'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://api.paypal.com/cert', 'paypal-transmission-id': 'tid-1', 'paypal-transmission-sig': 'sig==', 'paypal-transmission-time': '2026-10-04T10:00:00Z' };

    test('sends PayPal the headers, our webhook id and the event EXACTLY as received', async () => {
      reply({ ...TOKEN, 'POST /v1/notifications/verify-webhook-signature': { verification_status: 'SUCCESS' } });
      const raw = Buffer.from('{ "id":"WH-1",  "event_type":"BILLING.SUBSCRIPTION.ACTIVATED","resource":{"id":"I-1"} }');
      const event = await paypal.verifyWebhook(raw, headers);
      expect(event.id).toBe('WH-1');
      const sent = made('POST /v1/notifications/verify-webhook-signature')[0].body;
      expect(sent).toContain(raw.toString()); // untouched: spacing and key order preserved
      expect(JSON.parse(sent)).toMatchObject({ webhook_id: 'WH-TEST-1', transmission_id: 'tid-1', transmission_sig: 'sig==', auth_algo: 'SHA256withRSA', cert_url: headers['paypal-cert-url'] });
    });

    test('anything but SUCCESS is rejected', async () => {
      reply({ ...TOKEN, 'POST /v1/notifications/verify-webhook-signature': { verification_status: 'FAILURE' } });
      await expect(paypal.verifyWebhook(Buffer.from('{"id":"x"}'), headers)).rejects.toThrow(/signature/i);
    });

    test.each(Object.keys({ 'paypal-auth-algo': 1, 'paypal-cert-url': 1, 'paypal-transmission-id': 1, 'paypal-transmission-sig': 1, 'paypal-transmission-time': 1 }))('missing %s is rejected without calling PayPal', async (name) => {
      reply({ ...TOKEN });
      const partial = { ...headers };
      delete partial[name];
      await expect(paypal.verifyWebhook(Buffer.from('{"id":"x"}'), partial)).rejects.toThrow(/Missing/);
      expect(calls).toHaveLength(0);
    });

    test('a body that is not JSON is rejected before anything is sent', async () => {
      reply({ ...TOKEN });
      await expect(paypal.verifyWebhook(Buffer.from('not json'), headers)).rejects.toThrow();
      expect(calls).toHaveLength(0);
    });

    test('with no webhook id configured it refuses everything', async () => {
      const saved = config.paypal.webhookId;
      config.paypal.webhookId = '';
      try {
        await expect(paypal.verifyWebhook(Buffer.from('{}'), headers)).rejects.toThrow(/not configured/);
      } finally {
        config.paypal.webhookId = saved;
      }
    });

    test('over HTTP: a verified event gets 200 and acts; a failed check gets 400 and changes nothing', async () => {
      const body = JSON.stringify(evt('BILLING.SUBSCRIPTION.ACTIVATED'));
      reply({ ...TOKEN, 'POST /v1/notifications/verify-webhook-signature': { verification_status: 'FAILURE' } });
      const bad = await request(app).post('/api/payments/paypal/webhook').set('Content-Type', 'application/json').set(headers).send(body);
      expect(bad.status).toBe(400);
      expect((await reload(user)).isPro).toBe(false);

      await prisma.user.update({ where: { id: user.id }, data: { paypalSubscriptionId: 'I-TEST1', paymentProvider: 'paypal' } });
      reply({ ...TOKEN, 'POST /v1/notifications/verify-webhook-signature': { verification_status: 'SUCCESS' }, 'GET /v1/billing/subscriptions/ID': entityFor(user) });
      const good = await request(app).post('/api/payments/paypal/webhook').set('Content-Type', 'application/json').set(headers).send(body);
      expect(good.status).toBe(200);
      expect((await reload(user)).isPro).toBe(true);
    });
  });

  describe('what a webhook does: it is only a pointer', () => {
    const fire = (event, entity) => {
      reply({ ...TOKEN, 'GET /v1/billing/subscriptions/ID': entity });
      return paypal.handleWebhook(event);
    };

    test('ACTIVATED re-reads the subscription and grants the plan it was bought as, with its period end', async () => {
      await fire(evt('BILLING.SUBSCRIPTION.ACTIVATED'), entityFor(user));
      expect(made('GET /v1/billing/subscriptions/ID')).toHaveLength(1);
      const row = await reload(user);
      expect(row).toMatchObject({ isPro: true, plan: 'studio', subscriptionStatus: 'active', paymentProvider: 'paypal', paypalSubscriptionId: 'I-TEST1', subscriptionCancelAtPeriodEnd: false });
      expect(row.proPeriodEnd.getTime()).toBeGreaterThan(Date.now() + 25 * 86400000);
    });

    test('the event payload is never trusted: an ACTIVATED event for a subscription PayPal says is still pending grants nothing', async () => {
      await fire(evt('BILLING.SUBSCRIPTION.ACTIVATED', { id: 'I-TEST1', status: 'ACTIVE' }), entityFor(user, { status: 'APPROVAL_PENDING' }));
      expect(await reload(user)).toMatchObject({ isPro: false, plan: 'free', subscriptionStatus: 'incomplete' });
    });

    test('a completed sale points at its subscription through billing_agreement_id', async () => {
      await fire(evt('PAYMENT.SALE.COMPLETED', { id: 'SALE-1', billing_agreement_id: 'I-TEST1' }), entityFor(user));
      expect((await reload(user)).isPro).toBe(true);
    });

    test('an Agency plan is mapped from the remembered plan id', async () => {
      await prisma.providerPlan.create({ data: { provider: 'paypal', plan: 'agency', currency: 'usd', amount: config.stripe.plans.agency.usd.amount, providerPlanId: 'P-AGENCY' } });
      await fire(evt('BILLING.SUBSCRIPTION.ACTIVATED'), entityFor(user, { plan_id: 'P-AGENCY' }));
      expect((await reload(user)).plan).toBe('agency');
    });

    test('an unknown plan id keeps the plan the user already has', async () => {
      await prisma.user.update({ where: { id: user.id }, data: { plan: 'agency' } });
      await fire(evt('BILLING.SUBSCRIPTION.ACTIVATED'), entityFor(user, { plan_id: 'P-UNKNOWN' }));
      expect((await reload(user)).plan).toBe('agency');
    });

    test('a charge that failed but is still ACTIVE keeps access and shows as past due', async () => {
      await fire(evt('BILLING.SUBSCRIPTION.ACTIVATED'), entityFor(user));
      await fire(evt('BILLING.SUBSCRIPTION.PAYMENT.FAILED'), entityFor(user, { billing_info: { failed_payments_count: 1, next_billing_time: new Date(Date.now() + 5 * 86400000).toISOString() } }));
      expect(await reload(user)).toMatchObject({ isPro: true, subscriptionStatus: 'past_due', plan: 'studio' });
    });

    test.each([['SUSPENDED', 'unpaid'], ['CANCELLED', 'canceled'], ['EXPIRED', 'canceled']])('%s ends access', async (status, stored) => {
      await fire(evt('BILLING.SUBSCRIPTION.ACTIVATED'), entityFor(user));
      await fire(evt(`BILLING.SUBSCRIPTION.${status}`), entityFor(user, { status }));
      expect(await reload(user)).toMatchObject({ isPro: false, plan: 'free', subscriptionStatus: stored });
    });

    test('APPROVED (approved, first payment still to come) grants nothing', async () => {
      await fire(evt('BILLING.SUBSCRIPTION.CREATED'), entityFor(user, { status: 'APPROVED' }));
      expect(await reload(user)).toMatchObject({ isPro: false, subscriptionStatus: 'incomplete' });
    });

    test('a lifetime buyer stays Pro and Agency whatever happens to a subscription', async () => {
      await prisma.user.update({ where: { id: user.id }, data: { proLifetime: true, isPro: true, plan: 'agency' } });
      await fire(evt('BILLING.SUBSCRIPTION.CANCELLED'), entityFor(user, { status: 'CANCELLED' }));
      expect(await reload(user)).toMatchObject({ isPro: true, plan: 'agency' });
    });

    test('the same event delivered twice is applied once', async () => {
      const event = evt('BILLING.SUBSCRIPTION.ACTIVATED');
      await fire(event, entityFor(user));
      await prisma.user.update({ where: { id: user.id }, data: { isPro: false, plan: 'free' } });
      await fire(event, entityFor(user));
      expect((await reload(user)).isPro).toBe(false); // the replay did nothing
      expect(made('GET /v1/billing/subscriptions/ID')).toHaveLength(1);
    });

    test('a failure while applying forgets the event, so PayPal\'s retry is handled for real', async () => {
      const event = evt('BILLING.SUBSCRIPTION.ACTIVATED');
      reply({ ...TOKEN, 'GET /v1/billing/subscriptions/ID': { __error: 500 } });
      await expect(paypal.handleWebhook(event)).rejects.toMatchObject({ statusCode: 502 });
      await fire(event, entityFor(user));
      expect((await reload(user)).isPro).toBe(true);
    });

    test('events that are not about a subscription are ignored without calling PayPal', async () => {
      reply({ ...TOKEN });
      await paypal.handleWebhook(evt('CUSTOMER.DISPUTE.CREATED', { id: 'D-1' }));
      expect(calls).toHaveLength(0);
    });

    test('a subscription that is not ours changes nothing and does not fail', async () => {
      await fire(evt('BILLING.SUBSCRIPTION.ACTIVATED', { id: 'I-OTHER' }), entityFor({ id: 'nobody' }, { id: 'I-OTHER' }));
      expect((await reload(user)).isPro).toBe(false);
    });

    test('a second paid subscription for someone already paying is cancelled, not billed twice', async () => {
      await fire(evt('BILLING.SUBSCRIPTION.ACTIVATED'), entityFor(user));
      reply({ ...TOKEN, 'GET /v1/billing/subscriptions/ID': entityFor(user, { id: 'I-DUP' }), 'POST /v1/billing/subscriptions/ID/cancel': 204 });
      await paypal.handleWebhook(evt('BILLING.SUBSCRIPTION.ACTIVATED', { id: 'I-DUP' }));
      expect(made('POST /v1/billing/subscriptions/ID/cancel')).toHaveLength(1);
      expect((await reload(user)).paypalSubscriptionId).toBe('I-TEST1');
    });
  });

  describe('sync: when the buyer comes back from PayPal', () => {
    test('asks PayPal and applies the answer', async () => {
      await prisma.user.update({ where: { id: user.id }, data: { paypalSubscriptionId: 'I-TEST1', paymentProvider: 'paypal' } });
      reply({ ...TOKEN, 'GET /v1/billing/subscriptions/ID': entityFor(user) });
      expect(await paymentService.syncForUser(user.id)).toEqual({ isPro: true, status: 'active' });
    });

    test('never applies a subscription that was made for another account', async () => {
      await prisma.user.update({ where: { id: user.id }, data: { paypalSubscriptionId: 'I-TEST1', paymentProvider: 'paypal' } });
      reply({ ...TOKEN, 'GET /v1/billing/subscriptions/ID': entityFor({ id: 'someone-else' }) });
      expect((await paymentService.syncForUser(user.id)).isPro).toBe(false);
    });

    test('with nothing to sync it reports the stored state without calling PayPal', async () => {
      reply({});
      expect(await paypal.sync(user.id)).toEqual({ isPro: false, status: null });
      expect(calls).toHaveLength(0);
    });
  });

  describe('cancelling', () => {
    const subscribe = async (over = {}) => {
      reply({ ...TOKEN, 'GET /v1/billing/subscriptions/ID': entityFor(user, over) });
      await paypal.handleWebhook(evt('BILLING.SUBSCRIPTION.ACTIVATED'));
    };

    test('stops billing, records the cancel and keeps Pro on until the paid-until date', async () => {
      await subscribe();
      const end = new Date(Date.now() + 12 * 86400000).toISOString();
      reply({ ...TOKEN, 'GET /v1/billing/subscriptions/ID': entityFor(user, { billing_info: { next_billing_time: end } }), 'POST /v1/billing/subscriptions/ID/cancel': 204 });
      expect(await paymentService.cancelForUser(user.id)).toEqual({ cancelAtPeriodEnd: true });
      expect(made('POST /v1/billing/subscriptions/ID/cancel')[0].json).toEqual({ reason: 'Cancelled in Clientglass' });
      const row = await reload(user);
      expect(row).toMatchObject({ isPro: true, subscriptionCancelAtPeriodEnd: true });
      expect(row.proPeriodEnd.toISOString()).toBe(end);
    });

    test('PayPal\'s CANCELLED event after that does not take access away before the date', async () => {
      await subscribe();
      reply({ ...TOKEN, 'POST /v1/billing/subscriptions/ID/cancel': 204, 'GET /v1/billing/subscriptions/ID': entityFor(user) });
      await paypal.cancelAtPeriodEnd(user.id);
      reply({ ...TOKEN, 'GET /v1/billing/subscriptions/ID': entityFor(user, { status: 'CANCELLED', billing_info: {} }) });
      await paypal.handleWebhook(evt('BILLING.SUBSCRIPTION.CANCELLED'));
      expect(await reload(user)).toMatchObject({ isPro: true, plan: 'studio', subscriptionStatus: 'active', subscriptionCancelAtPeriodEnd: true });
    });

    test('once the date has passed, a CANCELLED event ends access', async () => {
      await subscribe();
      await prisma.user.update({ where: { id: user.id }, data: { subscriptionCancelAtPeriodEnd: true, proPeriodEnd: new Date(Date.now() - 86400000) } });
      reply({ ...TOKEN, 'GET /v1/billing/subscriptions/ID': entityFor(user, { status: 'CANCELLED', billing_info: {} }) });
      await paypal.handleWebhook(evt('BILLING.SUBSCRIPTION.CANCELLED'));
      expect(await reload(user)).toMatchObject({ isPro: false, plan: 'free', subscriptionStatus: 'canceled', subscriptionCancelAtPeriodEnd: false });
    });

    test('cancelling twice does not call PayPal again', async () => {
      await subscribe();
      reply({ ...TOKEN, 'POST /v1/billing/subscriptions/ID/cancel': 204, 'GET /v1/billing/subscriptions/ID': entityFor(user) });
      await paypal.cancelAtPeriodEnd(user.id);
      await paypal.cancelAtPeriodEnd(user.id);
      expect(made('POST /v1/billing/subscriptions/ID/cancel')).toHaveLength(1);
    });

    test('works while a failed charge is being retried (stored as past_due)', async () => {
      await subscribe();
      await prisma.user.update({ where: { id: user.id }, data: { subscriptionStatus: 'past_due' } });
      reply({ ...TOKEN, 'POST /v1/billing/subscriptions/ID/cancel': 204, 'GET /v1/billing/subscriptions/ID': entityFor(user) });
      await expect(paypal.cancelAtPeriodEnd(user.id)).resolves.toEqual({ cancelAtPeriodEnd: true });
    });

    test('refused when there is no live PayPal subscription', async () => {
      await expect(paypal.cancelAtPeriodEnd(user.id)).rejects.toMatchObject({ statusCode: 400 });
    });

    test('if PayPal says it can no longer be cancelled, the app re-reads it and says so', async () => {
      await subscribe();
      reply({ ...TOKEN, 'POST /v1/billing/subscriptions/ID/cancel': { __error: 422, name: 'SUBSCRIPTION_STATUS_INVALID' }, 'GET /v1/billing/subscriptions/ID': entityFor(user, { status: 'SUSPENDED' }) });
      await expect(paypal.cancelAtPeriodEnd(user.id)).rejects.toMatchObject({ statusCode: 400 });
      expect((await reload(user)).isPro).toBe(false); // the re-read applied PayPal's real state
    });

    test('over HTTP: needs sign-in, and works for the signed-in buyer', async () => {
      expect((await request(app).post('/api/payments/cancel')).status).toBe(401);
      await subscribe();
      reply({ ...TOKEN, 'POST /v1/billing/subscriptions/ID/cancel': 204, 'GET /v1/billing/subscriptions/ID': entityFor(user) });
      const res = await request(app).post('/api/payments/cancel').set('Authorization', `Bearer ${await accessTokenFor(user)}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, cancelAtPeriodEnd: true });
    });
  });

  describe('account deletion and the parts PayPal cannot do', () => {
    const subscribe = async () => {
      reply({ ...TOKEN, 'GET /v1/billing/subscriptions/ID': entityFor(user) });
      await paypal.handleWebhook(evt('BILLING.SUBSCRIPTION.ACTIVATED'));
    };

    test('deleting an account cancels the PayPal subscription', async () => {
      await subscribe();
      reply({ ...TOKEN, 'POST /v1/billing/subscriptions/ID/cancel': 204 });
      await paymentService.cancelSubscriptionForUser(user.id);
      expect(made('POST /v1/billing/subscriptions/ID/cancel')).toHaveLength(1);
    });

    test.each([['CANCELLED'], ['EXPIRED'], ['APPROVAL_PENDING']])('a %s subscription needs nothing more, so deletion goes ahead', async (status) => {
      await subscribe();
      reply({ ...TOKEN, 'POST /v1/billing/subscriptions/ID/cancel': { __error: 422 }, 'GET /v1/billing/subscriptions/ID': entityFor(user, { status }) });
      await expect(paymentService.cancelSubscriptionForUser(user.id)).resolves.toBeUndefined();
    });

    test.each([['ACTIVE'], ['APPROVED'], ['SUSPENDED']])('if a %s subscription cannot be cancelled, deletion is refused (never leave it billing)', async (status) => {
      await subscribe();
      reply({ ...TOKEN, 'POST /v1/billing/subscriptions/ID/cancel': { __error: 500 }, 'GET /v1/billing/subscriptions/ID': entityFor(user, { status }) });
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
      expect(JSON.stringify(res.body)).not.toContain('I-TEST1');
      expect(JSON.stringify(res.body)).toContain('paypal');
    });
  });
});
