// Regression coverage for real-money logic.
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
const mockCreate = jest.fn();
const mockPortalCreate = jest.fn();
const mockSubRetrieve = jest.fn();
const mockSubCancel = jest.fn();
jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({
    checkout: { sessions: { create: mockCreate, retrieve: mockRetrieve } },
    billingPortal: { sessions: { create: mockPortalCreate } },
    subscriptions: { retrieve: mockSubRetrieve, cancel: mockSubCancel },
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
    mockCreate.mockReset();
    mockPortalCreate.mockReset();
    mockSubRetrieve.mockReset();
    mockSubCancel.mockReset();
    jest.restoreAllMocks();
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

  // ── Monthly subscriptions ─────────────────────────────────────────────
  const evt = (type, object) => ({ id: `evt_${Date.now()}_${Math.random().toString(36).slice(2)}`, type, data: { object } });
  const reload = () => prisma.user.findUnique({ where: { id: user.id } });
  const DAY = 24 * 60 * 60;
  const inDays = (n) => Math.floor(Date.now() / 1000) + n * DAY;

  describe('createCheckoutSession — subscription mode', () => {
    test('creates a monthly subscription session tied to the user', async () => {
      user = await makeUser('sub-checkout');
      mockCreate.mockResolvedValue({ url: 'https://checkout.stripe.test/s' });

      const { url } = await paymentService.createCheckoutSession(user, 'usd');

      expect(url).toBe('https://checkout.stripe.test/s');
      const args = mockCreate.mock.calls[0][0];
      expect(args.mode).toBe('subscription');
      expect(args.line_items[0].price_data.recurring).toEqual({ interval: 'month' });
      expect(args.line_items[0].price_data.currency).toBe('usd');
      expect(args.metadata).toEqual({ userId: user.id });
      // Later customer.subscription.* events find their user through this.
      expect(args.subscription_data.metadata).toEqual({ userId: user.id });
      expect(args.client_reference_id).toBe(user.id);
      expect(args.customer_email).toBe(user.email);
      expect(args).not.toHaveProperty('customer');
      // `automatic_payment_methods` isn't a Checkout parameter for subscriptions.
      expect(args).not.toHaveProperty('automatic_payment_methods');
    });

    test('a returning subscriber reuses their Stripe customer instead of sending an email', async () => {
      user = await makeUser('sub-returning', { stripeCustomerId: 'cus_existing' });
      mockCreate.mockResolvedValue({ url: 'https://checkout.stripe.test/s' });

      await paymentService.createCheckoutSession(user, 'inr');

      const args = mockCreate.mock.calls[0][0];
      expect(args.customer).toBe('cus_existing');
      expect(args).not.toHaveProperty('customer_email'); // Stripe rejects both together
      expect(args.line_items[0].price_data.currency).toBe('inr');
    });

    test('refuses a lifetime (grandfathered) Pro user and an active subscriber', async () => {
      user = await makeUser('sub-already', { isPro: true, proLifetime: true });
      await expect(paymentService.createCheckoutSession(user, 'usd')).rejects.toThrow(/already/i);
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });

  describe('subscription lifecycle via webhooks', () => {
    test('a paid subscription checkout grants Pro and records the subscription — but not lifetime', async () => {
      user = await makeUser('sub-start');
      mockSubRetrieve.mockResolvedValue({ id: 'sub_123', status: 'active', metadata: { userId: user.id }, current_period_end: Math.floor(Date.now() / 1000) + 86400 });
      await paymentService.handleWebhookEvent(
        evt('checkout.session.completed', {
          mode: 'subscription',
          payment_status: 'paid',
          metadata: { userId: user.id },
          customer: 'cus_new',
          subscription: 'sub_123',
        })
      );
      const u = await reload();
      expect(u).toMatchObject({ isPro: true, proLifetime: false, subscriptionStatus: 'active' });
      const raw = await prisma.user.findUnique({
        where: { id: user.id },
        omit: { stripeCustomerId: false, stripeSubscriptionId: false },
      });
      expect(raw.stripeCustomerId).toBe('cus_new');
      expect(raw.stripeSubscriptionId).toBe('sub_123');
    });

    test('a legacy one-time (payment-mode) checkout completing late makes the buyer lifetime Pro', async () => {
      user = await makeUser('sub-legacy');
      await paymentService.handleWebhookEvent(
        evt('checkout.session.async_payment_succeeded', {
          mode: 'payment',
          payment_status: 'paid',
          metadata: { userId: user.id },
        })
      );
      expect(await reload()).toMatchObject({ isPro: true, proLifetime: true });
    });

    test('subscription.updated records the status and period end and keeps Pro', async () => {
      user = await makeUser('sub-renew', { isPro: true });
      const end = inDays(30);
      await paymentService.handleWebhookEvent(
        evt('customer.subscription.updated', {
          id: 'sub_renew',
          status: 'active',
          cancel_at_period_end: false,
          current_period_end: end,
          metadata: { userId: user.id },
        })
      );
      const u = await reload();
      expect(u).toMatchObject({ isPro: true, subscriptionStatus: 'active', subscriptionCancelAtPeriodEnd: false });
      expect(u.proPeriodEnd.getTime()).toBe(end * 1000);
    });

    test('reads the period end from the subscription item on newer Stripe API versions', async () => {
      user = await makeUser('sub-item-end');
      const end = inDays(10);
      await paymentService.handleWebhookEvent(
        evt('customer.subscription.updated', {
          id: 'sub_item_end',
          status: 'active',
          items: { data: [{ current_period_end: end }] },
          metadata: { userId: user.id },
        })
      );
      expect((await reload()).proPeriodEnd.getTime()).toBe(end * 1000);
    });

    test('cancel-at-period-end keeps Pro until the period ends and is flagged for the UI', async () => {
      user = await makeUser('sub-cancel-pending', { isPro: true });
      await paymentService.handleWebhookEvent(
        evt('customer.subscription.updated', {
          id: 'sub_cap',
          status: 'active',
          cancel_at_period_end: true,
          current_period_end: inDays(12),
          metadata: { userId: user.id },
        })
      );
      expect(await reload()).toMatchObject({ isPro: true, subscriptionCancelAtPeriodEnd: true });
    });

    test('past_due keeps Pro (Stripe is still retrying the card)', async () => {
      user = await makeUser('sub-past-due', { isPro: true });
      await paymentService.handleWebhookEvent(
        evt('customer.subscription.updated', { id: 'sub_pd', status: 'past_due', metadata: { userId: user.id } })
      );
      expect(await reload()).toMatchObject({ isPro: true, subscriptionStatus: 'past_due' });
    });

    test('unpaid ends Pro for a subscriber', async () => {
      user = await makeUser('sub-unpaid', { isPro: true });
      await paymentService.handleWebhookEvent(
        evt('customer.subscription.updated', { id: 'sub_up', status: 'unpaid', metadata: { userId: user.id } })
      );
      expect(await reload()).toMatchObject({ isPro: false, subscriptionStatus: 'unpaid' });
    });

    test('subscription.deleted ends Pro for a subscriber', async () => {
      user = await makeUser('sub-deleted', { isPro: true });
      await paymentService.handleWebhookEvent(
        evt('customer.subscription.deleted', {
          id: 'sub_del',
          status: 'canceled',
          cancel_at_period_end: true,
          metadata: { userId: user.id },
        })
      );
      expect(await reload()).toMatchObject({
        isPro: false,
        subscriptionStatus: 'canceled',
        subscriptionCancelAtPeriodEnd: false,
      });
    });

    test('a grandfathered lifetime user stays Pro when a subscription ends', async () => {
      user = await makeUser('sub-lifetime', { isPro: true, proLifetime: true });
      await paymentService.handleWebhookEvent(
        evt('customer.subscription.deleted', { id: 'sub_lt', status: 'canceled', metadata: { userId: user.id } })
      );
      expect(await reload()).toMatchObject({ isPro: true, proLifetime: true, subscriptionStatus: 'canceled' });
    });

    test('finds the user by subscription id when the event carries no metadata', async () => {
      user = await makeUser('sub-by-id', { isPro: true, stripeSubscriptionId: 'sub_lookup' });
      await paymentService.handleWebhookEvent(
        evt('customer.subscription.updated', { id: 'sub_lookup', status: 'unpaid', metadata: {} })
      );
      expect(await reload()).toMatchObject({ isPro: false, subscriptionStatus: 'unpaid' });
    });

    test('invoice.payment_failed marks past_due without revoking access', async () => {
      user = await makeUser('sub-invoice-fail', { isPro: true, stripeSubscriptionId: 'sub_inv' });
      await paymentService.handleWebhookEvent(evt('invoice.payment_failed', { subscription: 'sub_inv' }));
      expect(await reload()).toMatchObject({ isPro: true, subscriptionStatus: 'past_due' });
    });

    test('an event for an unknown user or subscription is a harmless no-op', async () => {
      await expect(
        paymentService.handleWebhookEvent(
          evt('customer.subscription.updated', { id: 'sub_nobody', status: 'active', metadata: { userId: 'ghost' } })
        )
      ).resolves.toBeUndefined();
    });
  });

  describe('webhook retry after a failed handler', () => {
    test('a failure un-records the event so Stripe’s retry is processed instead of skipped', async () => {
      user = await makeUser('sub-retry');
      const event = evt('customer.subscription.updated', {
        id: 'sub_retry',
        status: 'active',
        metadata: { userId: user.id },
      });

      jest.spyOn(prisma.user, 'findFirst').mockRejectedValueOnce(new Error('database blip'));
      await expect(paymentService.handleWebhookEvent(event)).rejects.toThrow('database blip');
      // Not left behind as "processed".
      expect(await prisma.webhookEvent.count({ where: { stripeEventId: event.id } })).toBe(0);

      // Stripe redelivers the same event — this time it really applies.
      await paymentService.handleWebhookEvent(event);
      expect(await reload()).toMatchObject({ isPro: true, subscriptionStatus: 'active' });
      expect(await prisma.webhookEvent.count({ where: { stripeEventId: event.id } })).toBe(1);
    });
  });

  describe('createPortalSession', () => {
    test('opens the customer portal for a user with a billing account', async () => {
      user = await makeUser('portal-ok', { stripeCustomerId: 'cus_portal' });
      mockPortalCreate.mockResolvedValue({ url: 'https://billing.stripe.test/p' });

      const { url } = await paymentService.createPortalSession(user.id);

      expect(url).toBe('https://billing.stripe.test/p');
      expect(mockPortalCreate.mock.calls[0][0]).toMatchObject({
        customer: 'cus_portal',
        return_url: expect.stringContaining('/settings'),
      });
    });

    test('refuses a user with no billing account', async () => {
      user = await makeUser('portal-none');
      await expect(paymentService.createPortalSession(user.id)).rejects.toMatchObject({ statusCode: 400 });
      expect(mockPortalCreate).not.toHaveBeenCalled();
    });
  });

  describe('reconcileSession — subscriptions', () => {
    test('a paid subscription session starts Pro without marking the user lifetime', async () => {
      user = await makeUser('reconcile-sub');
      mockSubRetrieve.mockResolvedValue({ id: 'sub_rec', status: 'active', metadata: { userId: user.id }, current_period_end: Math.floor(Date.now() / 1000) + 86400 });
      mockRetrieve.mockResolvedValue({
        mode: 'subscription',
        metadata: { userId: user.id },
        payment_status: 'paid',
        customer: 'cus_rec',
        subscription: 'sub_rec',
      });
      const result = await paymentService.reconcileSession('cs_sub', user.id);
      expect(result.isPro).toBe(true);
      expect(await reload()).toMatchObject({ isPro: true, proLifetime: false, subscriptionStatus: 'active' });
    });
  });

  describe('replayed paid checkout sessions never override the live subscription', () => {
    const paidSession = (userId) => ({
      mode: 'subscription',
      payment_status: 'paid',
      metadata: { userId },
      customer: 'cus_old',
      subscription: 'sub_old',
    });

    test('an old paid session whose subscription is cancelled does not re-grant Pro (webhook replay)', async () => {
      user = await makeUser('replay-webhook', { isPro: false });
      mockSubRetrieve.mockResolvedValue({ id: 'sub_old', status: 'canceled', metadata: { userId: user.id } });
      await paymentService.handleWebhookEvent(evt('checkout.session.completed', paidSession(user.id)));
      expect(await reload()).toMatchObject({ isPro: false, subscriptionStatus: 'canceled' });
    });

    test('revisiting the success_url session id after cancelling does not re-grant Pro (reconcile)', async () => {
      user = await makeUser('replay-reconcile', { isPro: false });
      mockRetrieve.mockResolvedValue(paidSession(user.id));
      mockSubRetrieve.mockResolvedValue({ id: 'sub_old', status: 'canceled', metadata: { userId: user.id } });
      const result = await paymentService.reconcileSession('cs_old', user.id);
      expect(result.isPro).toBe(false);
      expect(await reload()).toMatchObject({ isPro: false, subscriptionStatus: 'canceled' });
    });

    test('subscription.deleted followed by a late checkout.session.completed stays not-Pro', async () => {
      user = await makeUser('replay-order', { isPro: true });
      await paymentService.handleWebhookEvent(
        evt('customer.subscription.deleted', { id: 'sub_old', status: 'canceled', metadata: { userId: user.id } })
      );
      expect((await reload()).isPro).toBe(false);
      mockSubRetrieve.mockResolvedValue({ id: 'sub_old', status: 'canceled', metadata: { userId: user.id } });
      await paymentService.handleWebhookEvent(evt('checkout.session.completed', paidSession(user.id)));
      expect((await reload()).isPro).toBe(false);
    });

    test('a still-active subscription is Pro, and a grandfathered lifetime user stays Pro', async () => {
      user = await makeUser('replay-active', { isPro: false });
      mockSubRetrieve.mockResolvedValue({ id: 'sub_old', status: 'active', metadata: { userId: user.id } });
      await paymentService.handleWebhookEvent(evt('checkout.session.completed', paidSession(user.id)));
      expect(await reload()).toMatchObject({ isPro: true, subscriptionStatus: 'active' });
    });
  });
});

describe('cancelSubscriptionForUser (account deletion)', () => {
  let u;
  afterEach(async () => { if (u) await cleanupUsers(u); u = null; });

  test('does nothing for a user with no subscription', async () => {
    u = await makeUser('cancel-none');
    await paymentService.cancelSubscriptionForUser(u.id);
    expect(mockSubCancel).not.toHaveBeenCalled();
  });

  test('cancels a live subscription, treats "already gone" as success, and throws on any other Stripe error', async () => {
    u = await makeUser('cancel-live', { isPro: true });
    await prisma.user.update({ where: { id: u.id }, data: { stripeSubscriptionId: 'sub_live', subscriptionStatus: 'active' } });

    mockSubCancel.mockResolvedValueOnce({});
    await paymentService.cancelSubscriptionForUser(u.id);
    expect(mockSubCancel).toHaveBeenCalledWith('sub_live');

    mockSubCancel.mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'resource_missing' }));
    await expect(paymentService.cancelSubscriptionForUser(u.id)).resolves.toBeUndefined();

    mockSubCancel.mockRejectedValueOnce(new Error('stripe is down'));
    await expect(paymentService.cancelSubscriptionForUser(u.id)).rejects.toMatchObject({ statusCode: 502 });
  });
});
