// Regression coverage for real-money logic (PLAN's regression-debt item 1).
// `handleWebhookEvent`'s idempotency ledger is the part actually worth
// protecting and needs zero mocking — it operates on an already-parsed
// event object, never touching the Stripe SDK itself, so it runs against
// the real DB like everything else in this suite. The two functions that do
// call out to Stripe (createCheckoutSession, reconcileSession) get the
// `stripe` package mocked — this app's business logic is what's under test,
// not Stripe's own SDK — plus a fake secretKey injected via a partial mock
// of config/env, since no STRIPE_SECRET_KEY is configured in this
// environment (payments are opt-in and no-op gracefully without one; that's
// exactly why the mock is necessary to exercise this code path at all).
jest.mock('../src/config/env', () => {
  const actual = jest.requireActual('../src/config/env');
  return { ...actual, stripe: { ...actual.stripe, secretKey: 'sk_test_fake_key_for_tests' } };
});

const mockRetrieve = jest.fn();
jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({
    checkout: { sessions: { create: jest.fn(), retrieve: mockRetrieve } },
  }))
);

const prisma = require('../src/config/prisma');
const paymentService = require('../src/services/payment.service');
const { makeUser, cleanupUsers } = require('./helpers/fixtures');

describe('payment.service', () => {
  let user;

  afterEach(async () => {
    if (user) await cleanupUsers(user);
    user = null;
    mockRetrieve.mockReset();
  });

  describe('handleWebhookEvent — the idempotency ledger', () => {
    test('a checkout.session.completed event with a paid session grants isPro', async () => {
      user = await makeUser('webhook-grant');
      const event = {
        id: `evt_${Date.now()}_grant`,
        type: 'checkout.session.completed',
        data: { object: { payment_status: 'paid', metadata: { userId: user.id } } },
      };
      await paymentService.handleWebhookEvent(event);
      const reloaded = await prisma.user.findUnique({ where: { id: user.id } });
      expect(reloaded.isPro).toBe(true);
    });

    test('the exact same event id, redelivered, is a no-op — not a second grant attempt', async () => {
      user = await makeUser('webhook-idempotent');
      const event = {
        id: `evt_${Date.now()}_idempotent`,
        type: 'checkout.session.completed',
        data: { object: { payment_status: 'paid', metadata: { userId: user.id } } },
      };
      await paymentService.handleWebhookEvent(event);
      // Redelivery: Stripe sends this exact id again (timeout/retry, or even
      // after a clean 200) — must not throw and must not double-apply.
      await expect(paymentService.handleWebhookEvent(event)).resolves.toBeUndefined();

      const ledgerRows = await prisma.webhookEvent.count({ where: { stripeEventId: event.id } });
      expect(ledgerRows).toBe(1);
    });

    test('an irrelevant event type is recorded but does not grant isPro', async () => {
      user = await makeUser('webhook-irrelevant');
      const event = { id: `evt_${Date.now()}_irrelevant`, type: 'checkout.session.expired', data: { object: {} } };
      await paymentService.handleWebhookEvent(event);
      const reloaded = await prisma.user.findUnique({ where: { id: user.id } });
      expect(reloaded.isPro).toBe(false);
    });

    test('an unpaid session (e.g. UPI\'s first completed event, before async_payment_succeeded) does not grant isPro yet', async () => {
      user = await makeUser('webhook-unpaid');
      const event = {
        id: `evt_${Date.now()}_unpaid`,
        type: 'checkout.session.completed',
        data: { object: { payment_status: 'unpaid', metadata: { userId: user.id } } },
      };
      await paymentService.handleWebhookEvent(event);
      const reloaded = await prisma.user.findUnique({ where: { id: user.id } });
      expect(reloaded.isPro).toBe(false);
    });

    test('a forged/stale userId no-ops via updateMany rather than throwing', async () => {
      const event = {
        id: `evt_${Date.now()}_forged`,
        type: 'checkout.session.completed',
        data: { object: { payment_status: 'paid', metadata: { userId: 'does-not-exist' } } },
      };
      await expect(paymentService.handleWebhookEvent(event)).resolves.toBeUndefined();
    });
  });

  describe('createCheckoutSession — guards that fire before ever contacting Stripe', () => {
    test('rejects a user who already has isPro', async () => {
      user = await makeUser('already-pro', { isPro: true });
      await expect(paymentService.createCheckoutSession(user, 'usd')).rejects.toThrow();
    });

    test('rejects an unsupported currency', async () => {
      user = await makeUser('bad-currency');
      await expect(paymentService.createCheckoutSession(user, 'gbp')).rejects.toThrow();
    });
  });

  describe('reconcileSession — the ownership check', () => {
    test('rejects a session that belongs to a different user', async () => {
      user = await makeUser('reconcile-mismatch');
      mockRetrieve.mockResolvedValue({ metadata: { userId: 'someone-else' }, payment_status: 'paid' });
      await expect(paymentService.reconcileSession('cs_fake', user.id)).rejects.toThrow();
    });

    test('grants isPro when the session is paid and belongs to the caller', async () => {
      user = await makeUser('reconcile-match');
      mockRetrieve.mockResolvedValue({ metadata: { userId: user.id }, payment_status: 'paid', customer: null });
      const result = await paymentService.reconcileSession('cs_fake', user.id);
      expect(result.isPro).toBe(true);
      const reloaded = await prisma.user.findUnique({ where: { id: user.id } });
      expect(reloaded.isPro).toBe(true);
    });
  });
});
