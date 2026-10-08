const crypto = require('crypto');
const Stripe = require('stripe');
const config = require('../config/env');
const logger = require('../config/logger');
const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const audit = require('./audit.service');
const analytics = require('./analytics.service');
const gateways = require('./gateways');
const { PAID_PLANS, PLAN_NAMES, effectivePlan } = require('../utils/plans');

// Lazily constructed — throws only when a payment route is actually hit without
// keys configured, instead of crashing the whole app at boot.
let stripe = null;
const getStripe = () => {
  if (!config.stripe.secretKey) throw new AppError('Payments are not configured', 500);
  if (!stripe) stripe = new Stripe(config.stripe.secretKey);
  return stripe;
};

// Statuses in which a subscriber still has Pro. `past_due` keeps access on
// purpose: Stripe is still retrying the card, and cutting someone off the
// moment a payment bounces is how you lose a customer over an expired card.
// Stripe moves the subscription to `unpaid`/`canceled` if retries fail, which
// the next customer.subscription.updated/deleted event turns into isPro=false.
const ACTIVE_SUBSCRIPTION_STATUSES = ['active', 'trialing', 'past_due'];

// Clientglass is a monthly subscription in two paid plans (Studio, Agency) —
// Stripe Checkout in `subscription` mode. `currency` picks which price/currency
// the buyer pays in. No payment-method list is passed: Checkout then shows
// whatever is enabled in the Dashboard AND valid for a recurring payment in that
// currency (cards and wallets in general; recurring UPI depends on the account
// and the buyer's bank, so it isn't promised anywhere in the UI).
//
// The price is defined inline (`price_data`) from config rather than a Stripe
// Price id, so changing it is an environment-variable edit, not a dashboard
// object to keep in sync. The chosen plan rides along in the metadata of both
// the session and the subscription, which is how the webhook knows what was
// bought. With no plan given, the entry paid tier (Studio) is used.
// Which gateways can take each currency, in the order to offer them (first = preselected): only
// those configured, per config.paymentOrder, from the registry in gateways/. Also what the billing
// card asks, so it can show a "Pay with" choice, or say "unavailable", before a click.
exports.getOptions = () => ({ usd: gateways.forCurrency('usd').map(gateways.describe), inr: gateways.forCurrency('inr').map(gateways.describe) });

// Starts a checkout on the chosen gateway (or the first available for the currency). `phone` is only
// used by gateways that need it. Resolves to { provider, url } or, for an SDK gateway,
// { provider, sessionId, mode }.
exports.createCheckoutSession = async (user, currency = 'usd', plan = 'studio', { provider, phone } = {}) => {
  if (user.isPro) throw AppError.badRequest('Already upgraded to Pro');
  const available = gateways.forCurrency(currency);
  if (!available.length) throw new AppError('Payments are not available in this currency yet. Please try again later.', 503);
  const chosen = provider ? available.find((g) => g.id === provider) : available[0];
  if (!chosen) throw AppError.badRequest('That payment method is not available for this currency');
  return chosen.createCheckout(user, plan, currency, { phone });
};

// Stripe Checkout, the one gateway whose code lives in this file.
exports.stripeCheckout = async (user, currency = 'usd', plan = 'studio') => {
  if (!PAID_PLANS.includes(plan)) throw AppError.badRequest(`Unsupported plan: ${plan}`);
  const pricing = config.stripe.plans[plan][currency];
  if (!pricing) throw AppError.badRequest(`Unsupported currency: ${currency}`);

  // A returning subscriber (cancelled, now re-subscribing) keeps their Stripe
  // customer, so invoices and payment methods stay in one place. Stripe
  // rejects `customer` and `customer_email` together, so it's one or the other.
  // (stripeCustomerId is omitted from queries globally — opt back in here.)
  const billing = await prisma.user.findUnique({ where: { id: user.id }, omit: { stripeCustomerId: false } });

  const client = getStripe();
  const params = {
    mode: 'subscription',
    ...(billing?.stripeCustomerId ? { customer: billing.stripeCustomerId } : { customer_email: user.email }),
    client_reference_id: user.id,
    line_items: [
      {
        price_data: {
          currency,
          product_data: { name: `Clientglass ${PLAN_NAMES[plan]} — monthly` },
          unit_amount: pricing.amount,
          recurring: { interval: 'month' },
        },
        quantity: 1,
      },
    ],
    // `{CHECKOUT_SESSION_ID}` is a literal Stripe template token — it substitutes
    // the real session id into the redirect URL. Lets the frontend call
    // reconcileSession() as a fallback if the webhook is ever delayed/dropped.
    success_url: `${config.frontendUrl}/settings?upgrade=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${config.frontendUrl}/settings?upgrade=cancelled`,
    metadata: { userId: user.id, plan },
    // Every later customer.subscription.* event carries this, which is how a
    // renewal, cancellation or failed payment finds its user.
    subscription_data: { metadata: { userId: user.id, plan } },
  };
  // A double-click (or a retry after a timeout) must not create two checkout
  // sessions. The key is a hash of the whole request plus a 10-minute window: the
  // same request in that window gets the SAME session back from Stripe, while a
  // changed request (a different currency, a newly attached customer) gets a new
  // key, because Stripe rejects a reused key whose parameters differ.
  const window = Math.floor(Date.now() / (10 * 60 * 1000));
  const idempotencyKey = crypto.createHash('sha256').update(JSON.stringify([params, window])).digest('hex');
  const session = await client.checkout.sessions.create(params, { idempotencyKey });

  return { url: session.url, provider: 'stripe' };
};

// Moves a Studio subscriber to Agency by repricing their EXISTING subscription
// (prorated), instead of a second checkout that would leave two subscriptions
// billing. Only this upgrade is offered: a downgrade needs a decision on what
// happens to clients over the new limit, so it is not available here.
//
// Stripe holds the truth, so the live subscription is read first and refused
// unless it is healthy: active or trialing (not past_due: fix the card first) and
// not already set to end. The new price is created inline (Stripe needs a product
// id for a subscription item, unlike Checkout), in the subscription's own
// currency. The plan is then recorded straight away; the customer.subscription.
// updated event that follows says the same thing and is idempotent.
exports.changePlan = async (userId, plan) => {
  if (plan !== 'agency') throw AppError.badRequest('Only an upgrade to Agency can be made here');

  const user = await prisma.user.findUnique({ where: { id: userId }, omit: { stripeSubscriptionId: false } });
  if (!user) throw AppError.notFound('User not found');
  // Only Stripe can reprice a live subscription with proration. The others cannot edit one (a UPI
  // subscription is immutable) or document no way to prorate, so the switch is not offered there:
  // said plainly rather than half-done.
  const gateway = gateways.get(user.paymentProvider);
  if (gateway && !gateway.capabilities.planSwitch) {
    throw AppError.badRequest('Switching plans is not available for this subscription yet. Cancel it at the end of the period and subscribe to Agency, or contact support.');
  }
  const from = effectivePlan(user);
  if (from === 'free') throw AppError.badRequest('Subscribe to a plan first');
  if (from === 'agency') throw AppError.badRequest('You are already on Agency');
  if (!user.stripeSubscriptionId) throw AppError.badRequest('There is no subscription to change');

  const client = getStripe();
  let subscription;
  try {
    subscription = await client.subscriptions.retrieve(user.stripeSubscriptionId);
  } catch {
    throw new AppError('Could not read your subscription. Try again in a moment.', 502);
  }
  if (!['active', 'trialing'].includes(subscription.status)) {
    throw AppError.badRequest('Your last payment needs attention before you can change plan. Update your payment method under Manage billing.');
  }
  if (subscription.cancel_at_period_end) {
    throw AppError.badRequest('Your subscription is set to end. Resume it under Manage billing, then switch to Agency.');
  }
  const item = subscription.items?.data?.[0];
  if (!item) throw AppError.badRequest('There is no subscription item to change');

  const currency = item.price?.currency || subscription.currency;
  const pricing = config.stripe.plans.agency[currency];
  if (!pricing) throw AppError.badRequest(`Agency is not available in ${String(currency).toUpperCase()}`);

  // A double-click or a retry within the window changes the subscription once.
  const window = Math.floor(Date.now() / (10 * 60 * 1000));
  const key = crypto.createHash('sha256').update(JSON.stringify([user.stripeSubscriptionId, plan, currency, window])).digest('hex');

  let updated;
  try {
    const product = await client.products.create({ name: `Clientglass ${PLAN_NAMES[plan]} — monthly` }, { idempotencyKey: `${key}-product` });
    updated = await client.subscriptions.update(
      user.stripeSubscriptionId,
      {
        items: [{ id: item.id, price_data: { currency, product: product.id, unit_amount: pricing.amount, recurring: { interval: 'month' } } }],
        proration_behavior: 'create_prorations',
        metadata: { userId, plan },
      },
      { idempotencyKey: key }
    );
  } catch {
    throw new AppError('Could not change your plan, so nothing was changed. Try again, or contact support.', 502);
  }

  await applySubscription({ ...updated, metadata: { ...updated.metadata, userId, plan } }, 'plan_change', userId);
  await audit.record({ type: 'plan_changed', targetUserId: userId, meta: { from, to: plan, isPro: true } });
  return { tier: plan };
};

// Stripe's hosted Customer Portal — where a subscriber updates their card,
// views invoices and cancels. Needs to be enabled once in the Stripe Dashboard
// (Settings → Billing → Customer portal).
exports.createPortalSession = async (userId) => {
  const user = await prisma.user.findUnique({ where: { id: userId }, omit: { stripeCustomerId: false } });
  if (!user) throw AppError.notFound('User not found');
  const gateway = gateways.get(user.paymentProvider);
  if (gateway && !gateway.capabilities.portal) throw AppError.badRequest('This subscription is managed here: use Cancel subscription.');
  if (!user.stripeCustomerId) throw AppError.badRequest('There is no billing account to manage');

  const client = getStripe();
  const session = await client.billingPortal.sessions.create({
    customer: user.stripeCustomerId,
    return_url: `${config.frontendUrl}/settings?billing=updated`,
  });
  return { url: session.url };
};

// Verifies the Stripe signature and returns the parsed event. Throws on a bad
// signature so the controller can respond 400 (Stripe treats non-2xx as "retry me").
exports.verifyWebhookEvent = (rawBody, signature) => {
  const client = getStripe();
  if (!config.stripe.webhookSecret) throw new AppError('Stripe webhook secret not configured', 500);
  return client.webhooks.constructEvent(rawBody, signature, config.stripe.webhookSecret);
};

// Payment methods with delayed notification (UPI, some bank redirects, etc.)
// fire `checkout.session.completed` FIRST with `payment_status: 'unpaid'`, then
// `checkout.session.async_payment_succeeded` later once the payment actually
// clears — with the same Checkout Session shape (payment_status now 'paid').
// Both event types funnel into the same upgrade logic below.
const CHECKOUT_EVENT_TYPES = ['checkout.session.completed', 'checkout.session.async_payment_succeeded'];
const SUBSCRIPTION_EVENT_TYPES = [
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
];

// Stripe moved `current_period_end` from the subscription onto its items in
// newer API versions; read whichever this account's version provides.
const periodEndOf = (subscription) => {
  const seconds = subscription.current_period_end ?? subscription.items?.data?.[0]?.current_period_end;
  return seconds ? new Date(seconds * 1000) : null;
};

// The plan a subscription was bought as. A subscription with no recognised plan
// on it (one created before tiers existed, on the old flat price) is Agency, so
// existing subscribers keep every feature.
const planOf = (subscription) =>
  PAID_PLANS.includes(subscription.metadata?.plan) ? subscription.metadata.plan : 'agency';

const asId = (value) => (typeof value === 'string' ? value : value?.id);

// Grants Pro from a Checkout Session that has been paid. Shared by the webhook
// and the success-redirect reconciliation so both apply exactly the same rules.
//
// A `subscription`-mode session starts a monthly subscription. A `payment`-mode
// session can only be one created BEFORE subscriptions launched and completing
// late (a delayed payment method) — that buyer paid for the old lifetime
// upgrade, so they're marked lifetime, exactly like everyone grandfathered by
// the migration.
const applyPaidCheckoutSession = async (session, userId) => {
  const customerId = asId(session.customer);

  if (session.mode === 'subscription') {
    const subscriptionId = asId(session.subscription);
    if (!subscriptionId) return; // a paid subscription session always has one; nothing to verify against
    // A paid Checkout Session never stops being "paid", even after the
    // subscription it created is cancelled — so it says nothing about the
    // CURRENT entitlement. Replaying it (a late webhook, or the success_url
    // ?session_id=… revisited after cancelling) must not hand Pro back, so the
    // live subscription decides, never the session.
    const subscription = await getStripe().subscriptions.retrieve(subscriptionId);
    if (customerId) {
      // updateMany so a stale/forged userId no-ops instead of throwing.
      await prisma.user.updateMany({ where: { id: userId }, data: { stripeCustomerId: customerId } });
    }
    await applySubscription(subscription, 'checkout', userId);
  } else {
    const base = { isPro: true, ...(customerId ? { stripeCustomerId: customerId } : {}) };
    await prisma.user.updateMany({ where: { id: userId }, data: { ...base, proLifetime: true, plan: 'agency' } });
  }
};

// Keeps isPro, plan, status and period end in step with the subscription's real
// state. `isPro` is recomputed from proLifetime, so a grandfathered user
// whose (accidental) subscription ends stays Pro.
const applySubscription = async (subscription, eventType, knownUserId) => {
  const userId = knownUserId || subscription.metadata?.userId;
  const where = userId
    ? { id: userId }
    : { stripeSubscriptionId: subscription.id };
  const user = await prisma.user.findFirst({
    where,
    select: {
      id: true,
      proLifetime: true,
      isPro: true,
      stripeSubscriptionId: true,
      paymentProvider: true,
      subscriptionStatus: true,
    },
  });
  if (!user) return; // not one of ours (or already deleted) — nothing to update

  const ended =
    eventType === 'customer.subscription.deleted' ||
    subscription.status === 'canceled';

  // A different subscription is the one on file, or the buyer pays through another gateway: this
  // event is about one that is not the live subscription.
  const stripeOther =
    !!user.stripeSubscriptionId &&
    user.stripeSubscriptionId !== subscription.id;
  const payingNow = ['active', 'past_due'].includes(user.subscriptionStatus);
  const elsewhereLive =
    !!user.paymentProvider && user.paymentProvider !== 'stripe' && payingNow;
  if (stripeOther || elsewhereLive) {
    // A late event for an old/ended subscription must not switch off, or overwrite, the live one.
    if (ended) return;
    if (
      (stripeOther && user.paymentProvider === 'stripe' && payingNow) ||
      elsewhereLive
    ) {
      // A second live subscription for someone already paying: cancel it rather than bill twice.
      if (ACTIVE_SUBSCRIPTION_STATUSES.includes(subscription.status)) {
        try {
          await getStripe().subscriptions.cancel(subscription.id);
          await audit.record({
            type: 'duplicate_subscription_cancelled',
            targetUserId: user.id,
            meta: { provider: 'stripe' },
          });
        } catch {
          logger.error('Could not cancel a duplicate subscription', {
            userId: user.id,
            provider: 'stripe',
          });
        }
      }
      return;
    }
  }

  const status = ended ? 'canceled' : subscription.status;
  const nextIsPro =
    user.proLifetime ||
    (!ended && ACTIVE_SUBSCRIPTION_STATUSES.includes(status));
  if (nextIsPro !== user.isPro) {
    await audit.record({ type: 'plan_changed', targetUserId: user.id, meta: { isPro: nextIsPro, status } });
    if (nextIsPro) await analytics.track('upgraded', { userId: user.id });
  }
  await prisma.user.update({
    where: { id: user.id },
    data: {
      stripeSubscriptionId: subscription.id,
      paymentProvider: 'stripe',
      subscriptionStatus: status,
      proPeriodEnd: periodEndOf(subscription),
      subscriptionCancelAtPeriodEnd: !ended && !!subscription.cancel_at_period_end,
      isPro: nextIsPro,
      plan: user.proLifetime ? 'agency' : nextIsPro ? planOf(subscription) : 'free',
    },
  });
};

const processEvent = async (event) => {
  if (CHECKOUT_EVENT_TYPES.includes(event.type)) {
    const session = event.data.object;
    // `no_payment_required` is a fully-discounted or trial checkout.
    if (session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') return;
    const userId = session.metadata?.userId || session.client_reference_id;
    if (!userId) return;
    await applyPaidCheckoutSession(session, userId);
    return;
  }

  if (SUBSCRIPTION_EVENT_TYPES.includes(event.type)) {
    // Stripe does not deliver events in order, so a late one can describe a state that has since
    // changed. The subscription is read again so the CURRENT state is applied, never the event's.
    let subscription = event.data.object;
    try {
      if (config.stripe.secretKey) subscription = (await getStripe().subscriptions.retrieve(subscription.id)) || subscription;
    } catch (err) {
      if (err?.code !== 'resource_missing') throw err; // gone: the event's own copy is all there is
    }
    await applySubscription(subscription, event.type);
    return;
  }

  if (event.type === 'invoice.payment_failed') {
    // Status only — access isn't revoked here. Stripe retries the card and
    // tells us the outcome through customer.subscription.updated/deleted.
    const subscriptionId = asId(event.data.object.subscription);
    if (subscriptionId) {
      await prisma.user.updateMany({
        where: { stripeSubscriptionId: subscriptionId },
        data: { subscriptionStatus: 'past_due' },
      });
    }
  }
};

// Ends a user's subscription immediately, for account deletion. Throws when
// Stripe can't confirm the cancellation, so the caller can refuse to delete the
// account rather than leave a subscription billing nobody. An already-gone
// subscription (Stripe's resource_missing) counts as cancelled.
exports.cancelSubscriptionForUser = async (userId) => {
  const gateway = await exports.gatewayForUser(userId);
  if (gateway && gateway.id !== 'stripe') return gateway.cancelNow(userId);
  return exports.cancelStripeSubscription(userId);
};

// The gateway holding this user's subscription, or null when they have none (or a Stripe-era row
// from before the provider was recorded, which is Stripe's to handle).
exports.gatewayForUser = async (userId) => {
  const row = await prisma.user.findUnique({ where: { id: userId }, select: { paymentProvider: true } });
  return gateways.get(row?.paymentProvider);
};

// "What is the state of my payment?" for a gateway the app has to ask (no redirect back, or a late
// webhook). A gateway with no such call (Stripe: reconciled by session id) just reports the stored state.
exports.syncForUser = async (userId) => {
  const gateway = await exports.gatewayForUser(userId);
  if (gateway?.sync) return gateway.sync(userId);
  const row = await prisma.user.findUnique({ where: { id: userId }, select: { isPro: true, subscriptionStatus: true } });
  return { isPro: !!row?.isPro, status: row?.subscriptionStatus ?? null };
};

// Asks the gateway for the truth about one user's subscription and applies it. Used by the periodic
// reconciliation below: Stripe is read by subscription id (its events are the only other source).
const reconcileUser = async (userId) => {
  const gateway = await exports.gatewayForUser(userId);
  if (gateway?.sync) return gateway.sync(userId);
  if (!config.stripe.secretKey) return null;
  const row = await prisma.user.findUnique({ where: { id: userId }, select: { stripeSubscriptionId: true } });
  if (!row?.stripeSubscriptionId) return null;
  let subscription;
  try {
    subscription = await getStripe().subscriptions.retrieve(row.stripeSubscriptionId);
  } catch (err) {
    if (err?.code !== 'resource_missing') throw err;
    subscription = { id: row.stripeSubscriptionId, status: 'canceled', metadata: { userId } };
  }
  await applySubscription(subscription, 'reconcile', userId);
  return true;
};

// Safety net for a lost webhook (a cancel or a halt that never arrived): anyone still marked as paying
// whose paid period ended more than `graceDays` ago is checked against their gateway, which corrects
// them. A healthy subscriber's period end moves forward on every renewal, so they are never listed.
// Bounded per run; one failure does not stop the rest.
exports.reconcileStaleSubscriptions = async ({ now = new Date(), graceDays = 3, limit = 50 } = {}) => {
  const stale = await prisma.user.findMany({
    where: {
      isPro: true,
      proLifetime: false,
      paymentProvider: { not: null },
      subscriptionCancelAtPeriodEnd: false,
      subscriptionStatus: { in: ['active', 'past_due', 'trialing'] },
      proPeriodEnd: { lt: new Date(now.getTime() - graceDays * 24 * 60 * 60 * 1000) },
    },
    select: { id: true },
    take: limit,
  });
  let checked = 0;
  for (const { id } of stale) {
    try {
      await reconcileUser(id);
      checked += 1;
    } catch (err) {
      logger.warn('Subscription reconciliation failed for one user', { userId: id, error: err.message });
    }
  }
  return checked;
};

// The in-app Cancel button, for gateways without a hosted billing page.
exports.cancelForUser = async (userId) => {
  const gateway = await exports.gatewayForUser(userId);
  if (!gateway?.cancelAtPeriodEnd) throw AppError.badRequest('Manage this subscription under Manage billing.');
  return gateway.cancelAtPeriodEnd(userId);
};

exports.cancelStripeSubscription = async (userId) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { stripeSubscriptionId: true, subscriptionStatus: true },
  });
  if (!user?.stripeSubscriptionId || user.subscriptionStatus === 'canceled') return;
  try {
    await getStripe().subscriptions.cancel(user.stripeSubscriptionId);
  } catch (err) {
    if (err?.code === 'resource_missing') return;
    throw new AppError('Could not cancel your subscription, so your account was not deleted. Try again, or contact support.', 502);
  }
};

exports.handleWebhookEvent = async (event) => {
  // Idempotency: record the event id before doing anything else. Stripe
  // redelivers on timeout/non-2xx and can occasionally redeliver even after a
  // clean 200 — a unique-constraint conflict here means "already processed",
  // so bail out before re-applying any side effect.
  try {
    await prisma.webhookEvent.create({ data: { stripeEventId: event.id, type: event.type } });
  } catch (err) {
    if (err.code === 'P2002') return; // already processed this exact event
    throw err;
  }

  try {
    await processEvent(event);
  } catch (err) {
    // The ledger row says "processed", but it wasn't — if it stayed, Stripe's
    // retry would hit the conflict above and be skipped forever, silently
    // losing the upgrade (or the cancellation). Forget the event so the retry
    // that this error triggers (we respond 5xx) is handled for real.
    await prisma.webhookEvent.deleteMany({ where: { stripeEventId: event.id } }).catch(() => {});
    throw err;
  }
};

// Reconciliation fallback for the success-redirect path: if a webhook was ever
// delayed or dropped, the frontend calls this (with the session id Stripe
// appended to success_url) so a missed webhook doesn't leave a paying user
// stuck un-upgraded with no way to notice. Safe to call even if the webhook
// already landed — it just re-confirms the same state.
exports.reconcileSession = async (sessionId, userId) => {
  const client = getStripe();
  const session = await client.checkout.sessions.retrieve(sessionId);

  const sessionUserId = session.metadata?.userId || session.client_reference_id;
  if (sessionUserId !== userId) throw AppError.forbidden('This checkout session does not belong to you');

  if (session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') {
    return { isPro: false, paymentStatus: session.payment_status };
  }

  await applyPaidCheckoutSession(session, userId);
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { isPro: true } });
  return { isPro: !!user?.isPro, paymentStatus: session.payment_status };
};
