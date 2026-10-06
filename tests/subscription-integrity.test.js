// Late, out-of-order and duplicate subscription events must never switch off or overwrite the
// subscription that is billing now.
jest.mock('../src/config/env', () => {
  const actual = jest.requireActual('../src/config/env');
  return { ...actual, stripe: { ...actual.stripe, secretKey: 'sk_test_fake_key_for_tests' } };
});

const mockSubRetrieve = jest.fn();
const mockSubCancel = jest.fn();
jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({
    checkout: { sessions: { create: jest.fn(), retrieve: jest.fn() } },
    billingPortal: { sessions: { create: jest.fn() } },
    subscriptions: { retrieve: mockSubRetrieve, cancel: mockSubCancel },
  }))
);

const prisma = require('../src/config/prisma');
const paymentService = require('../src/services/payment.service');
const subscriptionState = require('../src/services/subscriptionState');
const { makeUser, cleanupUsers } = require('./helpers/fixtures');

let n = 0;
const evt = (type, object) => ({ id: `evt_${Date.now()}_${n++}`, type, data: { object } });
const future = () => Math.floor(Date.now() / 1000) + 30 * 86400;

describe('subscription integrity', () => {
  let user;
  const reload = () => prisma.user.findUnique({ where: { id: user.id }, select: { isPro: true, subscriptionStatus: true, paymentProvider: true, stripeSubscriptionId: true } });
  afterEach(async () => {
    if (user) await cleanupUsers(user);
    user = null;
    mockSubRetrieve.mockReset();
    mockSubCancel.mockReset();
  });

  test('a late "deleted" event for an OLD Stripe subscription does not switch off the live one', async () => {
    user = await makeUser('si-old-deleted');
    mockSubRetrieve.mockImplementation(async (id) => ({ id, status: 'active', metadata: { userId: user.id }, current_period_end: future() }));
    await paymentService.handleWebhookEvent(evt('customer.subscription.created', { id: 'sub_B', status: 'active', metadata: { userId: user.id } }));
    expect(await reload()).toMatchObject({ isPro: true, stripeSubscriptionId: 'sub_B' });

    mockSubRetrieve.mockImplementation(async (id) => ({ id, status: 'canceled', metadata: { userId: user.id } }));
    await paymentService.handleWebhookEvent(evt('customer.subscription.deleted', { id: 'sub_A', status: 'canceled', metadata: { userId: user.id } }));
    expect(await reload()).toMatchObject({ isPro: true, subscriptionStatus: 'active', stripeSubscriptionId: 'sub_B' });
  });

  test('a second live Stripe subscription for someone already paying is cancelled, not recorded', async () => {
    user = await makeUser('si-dup');
    mockSubRetrieve.mockImplementation(async (id) => ({ id, status: 'active', metadata: { userId: user.id }, current_period_end: future() }));
    await paymentService.handleWebhookEvent(evt('customer.subscription.created', { id: 'sub_1', status: 'active', metadata: { userId: user.id } }));
    await paymentService.handleWebhookEvent(evt('customer.subscription.created', { id: 'sub_2', status: 'active', metadata: { userId: user.id } }));
    expect(mockSubCancel).toHaveBeenCalledWith('sub_2');
    expect(await reload()).toMatchObject({ isPro: true, stripeSubscriptionId: 'sub_1' });
  });

  test('an out-of-order event applies the subscription as it is NOW, not the event copy', async () => {
    user = await makeUser('si-order');
    mockSubRetrieve.mockImplementation(async (id) => ({ id, status: 'active', metadata: { userId: user.id }, current_period_end: future() }));
    // A stale "incomplete" copy arrives after the subscription became active.
    await paymentService.handleWebhookEvent(evt('customer.subscription.created', { id: 'sub_N', status: 'incomplete', metadata: { userId: user.id } }));
    expect(await reload()).toMatchObject({ isPro: true, subscriptionStatus: 'active' });
  });

  test('a late ended event from Stripe does not switch off a buyer paying through another gateway', async () => {
    user = await makeUser('si-cross', { isPro: true });
    await prisma.user.update({ where: { id: user.id }, data: { paymentProvider: 'razorpay', subscriptionStatus: 'active' } });
    mockSubRetrieve.mockImplementation(async (id) => ({ id, status: 'canceled', metadata: { userId: user.id } }));
    await paymentService.handleWebhookEvent(evt('customer.subscription.deleted', { id: 'sub_X', status: 'canceled', metadata: { userId: user.id } }));
    expect(await reload()).toMatchObject({ isPro: true, paymentProvider: 'razorpay', subscriptionStatus: 'active' });
  });

  test('a gateway event for an older subscription id is ignored; a second live one is cancelled', async () => {
    user = await makeUser('si-gw', { isPro: true });
    await prisma.user.update({ where: { id: user.id }, data: { paymentProvider: 'paypal', paypalSubscriptionId: 'I-LIVE', subscriptionStatus: 'active' } });
    const base = { provider: 'paypal', idColumn: 'paypalSubscriptionId', userHint: user.id };
    await subscriptionState.applyGatewayState({ ...base, id: 'I-OLD', state: { status: 'canceled', paid: false, ended: true, periodEnd: null, plan: null } });
    expect(await reload()).toMatchObject({ isPro: true, subscriptionStatus: 'active' });

    const cancelDuplicate = jest.fn();
    await subscriptionState.applyGatewayState({ ...base, id: 'I-NEW', cancelDuplicate, state: { status: 'active', paid: true, ended: false, periodEnd: null, plan: 'studio' } });
    expect(cancelDuplicate).toHaveBeenCalledWith('I-NEW');
  });

  test('a price env var that is set but malformed throws at load', () => {
    jest.isolateModules(() => {
      process.env.STUDIO_PRICE_USD_CENTS = '19.00';
      expect(() => jest.requireActual('../src/config/env')).toThrow(/STUDIO_PRICE_USD_CENTS/);
      delete process.env.STUDIO_PRICE_USD_CENTS;
    });
  });
});

describe('reconcileStaleSubscriptions', () => {
  let u;
  afterEach(async () => {
    if (u) await cleanupUsers(u);
    u = null;
    mockSubRetrieve.mockReset();
  });

  test('a subscriber whose period ended days ago and whose cancel webhook was lost is corrected from Stripe', async () => {
    u = await makeUser('si-stale', { isPro: true });
    await prisma.user.update({
      where: { id: u.id },
      data: { paymentProvider: 'stripe', stripeSubscriptionId: 'sub_lost', subscriptionStatus: 'active', plan: 'studio', proPeriodEnd: new Date(Date.now() - 10 * 86400000) },
    });
    mockSubRetrieve.mockResolvedValue({ id: 'sub_lost', status: 'canceled', metadata: { userId: u.id } });
    expect(await paymentService.reconcileStaleSubscriptions()).toBeGreaterThanOrEqual(1);
    expect(await prisma.user.findUnique({ where: { id: u.id } })).toMatchObject({ isPro: false, subscriptionStatus: 'canceled' });
  });

  test('a healthy subscriber (period end in the future) is never touched', async () => {
    u = await makeUser('si-fresh', { isPro: true });
    await prisma.user.update({
      where: { id: u.id },
      data: { paymentProvider: 'stripe', stripeSubscriptionId: 'sub_ok', subscriptionStatus: 'active', proPeriodEnd: new Date(Date.now() + 5 * 86400000) },
    });
    await paymentService.reconcileStaleSubscriptions();
    expect(mockSubRetrieve).not.toHaveBeenCalled();
  });
});
