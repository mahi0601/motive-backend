const Stripe = require('stripe');
const config = require('../config/env');
const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const audit = require('./audit.service');

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

// Motive Pro is a monthly subscription — Stripe Checkout in `subscription` mode.
// `currency` picks which price/currency the buyer pays in. No payment-method
// list is passed: Checkout then shows whatever is enabled in the Dashboard AND
// valid for a recurring payment in that currency (cards and wallets in general;
// recurring UPI depends on the account and the buyer's bank, so it isn't
// promised anywhere in the UI).
//
// The price is defined inline (`price_data`) from config rather than a Stripe
// Price id, so changing it is an environment-variable edit, not a dashboard
// object to keep in sync. NOTE the PRO_UPGRADE_PRICE_* values are now
// per-MONTH amounts (they used to be a one-time total).
exports.createCheckoutSession = async (user, currency = 'usd') => {
  if (user.isPro) throw AppError.badRequest('Already upgraded to Pro');

  const pricing = config.stripe.proPricing[currency];
  if (!pricing) throw AppError.badRequest(`Unsupported currency: ${currency}`);

  // A returning subscriber (cancelled, now re-subscribing) keeps their Stripe
  // customer, so invoices and payment methods stay in one place. Stripe
  // rejects `customer` and `customer_email` together, so it's one or the other.
  // (stripeCustomerId is omitted from queries globally — opt back in here.)
  const billing = await prisma.user.findUnique({ where: { id: user.id }, omit: { stripeCustomerId: false } });

  const client = getStripe();
  const session = await client.checkout.sessions.create({
    mode: 'subscription',
    ...(billing?.stripeCustomerId ? { customer: billing.stripeCustomerId } : { customer_email: user.email }),
    client_reference_id: user.id,
    line_items: [
      {
        price_data: {
          currency,
          product_data: { name: 'Motive Pro — monthly' },
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
    metadata: { userId: user.id },
    // Every later customer.subscription.* event carries this, which is how a
    // renewal, cancellation or failed payment finds its user.
    subscription_data: { metadata: { userId: user.id } },
  });

  return { url: session.url };
};

// Stripe's hosted Customer Portal — where a subscriber updates their card,
// views invoices and cancels. Needs to be enabled once in the Stripe Dashboard
// (Settings → Billing → Customer portal).
exports.createPortalSession = async (userId) => {
  const user = await prisma.user.findUnique({ where: { id: userId }, omit: { stripeCustomerId: false } });
  if (!user) throw AppError.notFound('User not found');
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
    await prisma.user.updateMany({ where: { id: userId }, data: { ...base, proLifetime: true } });
  }
};

// Keeps isPro, status and period end in step with the subscription's real
// state. `isPro` is recomputed from proLifetime, so a grandfathered user
// whose (accidental) subscription ends stays Pro.
const applySubscription = async (subscription, eventType, knownUserId) => {
  const userId = knownUserId || subscription.metadata?.userId;
  const where = userId ? { id: userId } : { stripeSubscriptionId: subscription.id };
  const user = await prisma.user.findFirst({ where, select: { id: true, proLifetime: true, isPro: true } });
  if (!user) return; // not one of ours (or already deleted) — nothing to update

  const ended = eventType === 'customer.subscription.deleted' || subscription.status === 'canceled';
  const status = ended ? 'canceled' : subscription.status;
  const nextIsPro = user.proLifetime || (!ended && ACTIVE_SUBSCRIPTION_STATUSES.includes(status));
  if (nextIsPro !== user.isPro) {
    await audit.record({ type: 'plan_changed', targetUserId: user.id, meta: { isPro: nextIsPro, status } });
  }
  await prisma.user.update({
    where: { id: user.id },
    data: {
      stripeSubscriptionId: subscription.id,
      subscriptionStatus: status,
      proPeriodEnd: periodEndOf(subscription),
      subscriptionCancelAtPeriodEnd: !ended && !!subscription.cancel_at_period_end,
      isPro: user.proLifetime || (!ended && ACTIVE_SUBSCRIPTION_STATUSES.includes(status)),
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
    await applySubscription(event.data.object, event.type);
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
