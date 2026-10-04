// Razorpay: monthly subscriptions paid in INR (cards and UPI AutoPay), for buyers in India
// where Stripe is invite-only. It plugs into the same user columns Stripe uses
// (isPro, plan, subscriptionStatus, proPeriodEnd, subscriptionCancelAtPeriodEnd), so every
// gate in the app reads the same flags whichever gateway took the money.
//
// Talks to Razorpay's REST API directly (Basic auth, fetch): four calls, no SDK to keep up
// to date. Differences from Stripe worth knowing, because they shape this file:
//  - A plan must exist before a subscription; they are created on demand and remembered
//    (ProviderPlan), keyed by amount so a price change never edits a plan in use.
//  - The payment link has no redirect back to the site, so the app learns of a payment from
//    the webhook, or from `sync` when the buyer returns and the app asks Razorpay directly.
//  - There is no customer portal, so cancelling is done here (at the end of the period).
//  - A subscription cannot be reactivated once cancelled, and a UPI subscription cannot be
//    edited, so there is no in-app plan switch (payment.service.js says so plainly).
const crypto = require('crypto');
const config = require('../config/env');
const logger = require('../config/logger');
const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const audit = require('./audit.service');
const { PAID_PLANS, PLAN_NAMES } = require('../utils/plans');
const { applyGatewayState, PAYING } = require('./subscriptionState');

const API = 'https://api.razorpay.com/v1';
const CURRENCY = 'INR';
const AUTHORIZE_WITHIN_SECONDS = 24 * 60 * 60;

exports.isConfigured = () => !!(config.razorpay.keyId && config.razorpay.keySecret);

// Razorpay statuses in which the subscriber has paid access. `pending` means a charge failed
// and Razorpay is retrying: access stays on, like Stripe's past_due, so a bounced card does
// not cut someone off mid-retry. `halted` (retries used up) and the ended states do not.
const PAID_STATUSES = ['active', 'pending'];
const ENDED_STATUSES = ['cancelled', 'completed', 'expired'];

// One call to Razorpay. Failures become a 502 with a plain message: what Razorpay said is
// logged (status and error code, never the body, which can hold card or contact details).
const call = async (method, path, body) => {
  if (!exports.isConfigured()) throw new AppError('Payments are not configured', 503);
  const auth = Buffer.from(`${config.razorpay.keyId}:${config.razorpay.keySecret}`).toString('base64');
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    logger.warn('razorpay request failed', { path, err: err?.message });
    throw new AppError('Could not reach the payment provider. Try again in a moment.', 502);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    logger.warn('razorpay error', { method, path, status: res.status, code: data?.error?.code });
    const err = new AppError('The payment provider could not complete that. Try again, or contact support.', 502);
    err.razorpayStatus = res.status;
    err.razorpayCode = data?.error?.code;
    throw err;
  }
  return data;
};
exports._call = call;

const priceOf = (plan) => {
  const pricing = config.stripe.plans[plan]?.inr;
  if (!pricing) throw AppError.badRequest('That plan is not available in INR');
  return pricing.amount;
};

// The Razorpay plan for this plan and amount: remembered if we made it before, created once
// if not. Two checkouts racing to create the same plan end with one row (the unique key) and
// the loser uses the winner's.
const providerPlanFor = async (plan, amount) => {
  const key = { provider: 'razorpay', plan, currency: CURRENCY.toLowerCase(), amount };
  const found = await prisma.providerPlan.findUnique({ where: { provider_plan_currency_amount: key } });
  if (found) return found.providerPlanId;
  const created = await call('POST', '/plans', {
    period: 'monthly',
    interval: 1,
    item: { name: `Clientglass ${PLAN_NAMES[plan]} — monthly`, amount, currency: CURRENCY },
    notes: { plan },
  });
  try {
    await prisma.providerPlan.create({ data: { ...key, providerPlanId: created.id } });
    return created.id;
  } catch (err) {
    if (err.code !== 'P2002') throw err;
    return (await prisma.providerPlan.findUnique({ where: { provider_plan_currency_amount: key } })).providerPlanId;
  }
};

// Starts a subscription and returns Razorpay's hosted payment link. A buyer who clicks twice
// (or comes back to the page) gets the SAME unpaid link for the same plan rather than a
// second subscription that could be paid as well and bill twice.
exports.createCheckout = async (user, plan) => {
  if (user.isPro) throw AppError.badRequest('Already upgraded to Pro');
  if (!PAID_PLANS.includes(plan)) throw AppError.badRequest(`Unsupported plan: ${plan}`);
  const amount = priceOf(plan);

  const stored = await prisma.user.findUnique({ where: { id: user.id }, omit: { razorpaySubscriptionId: false } });
  if (stored?.razorpaySubscriptionId) {
    try {
      const open = await call('GET', `/subscriptions/${encodeURIComponent(stored.razorpaySubscriptionId)}`);
      const stillOpen = open.status === 'created' && open.notes?.plan === plan && (!open.expire_by || open.expire_by * 1000 > Date.now() + 60 * 1000);
      if (stillOpen && open.short_url) return { url: open.short_url };
    } catch {
      // An unreadable old subscription must not block a new checkout; a new one is made below.
    }
  }

  const planId = await providerPlanFor(plan, amount);
  const subscription = await call('POST', '/subscriptions', {
    plan_id: planId,
    total_count: config.razorpay.totalCount,
    customer_notify: 1,
    expire_by: Math.floor(Date.now() / 1000) + AUTHORIZE_WITHIN_SECONDS,
    notes: { userId: user.id, plan },
  });
  if (!subscription.short_url) throw new AppError('The payment provider did not return a payment link. Try again.', 502);

  // Remembered now so `sync` can ask Razorpay about it when the buyer comes back, before any
  // webhook has arrived. It grants nothing: only a paid status does that.
  await prisma.user.update({ where: { id: user.id }, data: { razorpaySubscriptionId: subscription.id, paymentProvider: 'razorpay' } });
  return { url: subscription.short_url };
};

// ---- applying what Razorpay says ------------------------------------------------------

const planOf = (entity) => (PAID_PLANS.includes(entity.notes?.plan) ? entity.notes.plan : 'agency');
const dateOf = (seconds) => (seconds ? new Date(seconds * 1000) : null);

// Brings the user's flags in line with a Razorpay subscription by mapping its status onto the
// shared state (subscriptionState.js). Used by the webhook and by sync, which say the same thing
// and are both idempotent.
const stateOf = (entity) => ({
  // `pending` = a charge failed and Razorpay is retrying: stored as past_due, access stays on.
  status: entity.status === 'pending' ? 'past_due' : entity.status === 'halted' ? 'unpaid' : ENDED_STATUSES.includes(entity.status) ? 'canceled' : entity.status,
  paid: PAID_STATUSES.includes(entity.status),
  inFlight: entity.status === 'authenticated',
  ended: ENDED_STATUSES.includes(entity.status),
  periodEnd: dateOf(entity.current_end),
  plan: planOf(entity),
});

const applySubscription = (entity) =>
  applyGatewayState({
    provider: 'razorpay',
    idColumn: 'razorpaySubscriptionId',
    id: entity?.id,
    userHint: entity?.notes?.userId,
    state: stateOf(entity || {}),
    cancelDuplicate: (id) => call('POST', `/subscriptions/${encodeURIComponent(id)}/cancel`, { cancel_at_cycle_end: 0 }),
  });

// ---- webhook --------------------------------------------------------------------------

// Verifies Razorpay's signature (HMAC-SHA256 of the RAW body, hex, with the webhook secret
// from the dashboard: not the API key secret) and returns the parsed event. Throws on a bad
// or missing signature, so the controller answers 400.
exports.verifyWebhook = (rawBody, signature) => {
  const secret = config.razorpay.webhookSecret;
  if (!secret) throw new AppError('Razorpay webhook secret not configured', 500);
  if (typeof signature !== 'string' || !signature) throw new Error('Missing signature');
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody));
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('Invalid signature');
  return JSON.parse(body.toString('utf8'));
};

// Same ledger as Stripe's: the id is recorded first, a conflict means "already processed", and
// a failure forgets it so Razorpay's retry is handled for real. Razorpay sends a unique id per
// event in X-Razorpay-Event-Id; if it is ever absent the body's hash stands in for it.
exports.handleWebhook = async (event, { eventId, rawBody } = {}) => {
  const id = `razorpay:${eventId || crypto.createHash('sha256').update(rawBody || JSON.stringify(event)).digest('hex')}`;
  try {
    await prisma.webhookEvent.create({ data: { stripeEventId: id, type: String(event.event || 'unknown').slice(0, 100) } });
  } catch (err) {
    if (err.code === 'P2002') return;
    throw err;
  }
  try {
    if (String(event.event).startsWith('subscription.')) {
      await applySubscription(event.payload?.subscription?.entity);
    }
  } catch (err) {
    await prisma.webhookEvent.deleteMany({ where: { stripeEventId: id } }).catch(() => {});
    throw err;
  }
};

// ---- the buyer's side -----------------------------------------------------------------

// Asks Razorpay for the truth about this user's subscription and applies it: the fallback
// for a webhook that is late or dropped, called when the buyer returns from paying.
exports.sync = async (userId) => {
  const user = await prisma.user.findUnique({ where: { id: userId }, omit: { razorpaySubscriptionId: false } });
  if (!user) throw AppError.notFound('User not found');
  if (user.razorpaySubscriptionId) {
    const entity = await call('GET', `/subscriptions/${encodeURIComponent(user.razorpaySubscriptionId)}`);
    // Belt and braces: only ever apply a subscription that was created for this account.
    if (entity.notes?.userId === userId) await applySubscription(entity);
  }
  const fresh = await prisma.user.findUnique({ where: { id: userId }, select: { isPro: true, subscriptionStatus: true } });
  return { isPro: !!fresh?.isPro, status: fresh?.subscriptionStatus ?? null };
};

// Cancels at the end of the paid period: Pro stays on until then, and the cancelled event that
// follows ends it. Razorpay cannot reactivate a cancelled subscription, so the buyer subscribes
// again afterwards (the UI says so). Refused when there is nothing live to cancel.
exports.cancelAtPeriodEnd = async (userId) => {
  const user = await prisma.user.findUnique({ where: { id: userId }, omit: { razorpaySubscriptionId: false } });
  if (!user?.razorpaySubscriptionId || user.paymentProvider !== 'razorpay') throw AppError.badRequest('There is no subscription to cancel here');
  // Compared against OUR stored status: a charge being retried is stored as past_due.
  if (!PAYING.includes(user.subscriptionStatus)) throw AppError.badRequest('There is no active subscription to cancel');
  if (user.subscriptionCancelAtPeriodEnd) return { cancelAtPeriodEnd: true };
  try {
    await call('POST', `/subscriptions/${encodeURIComponent(user.razorpaySubscriptionId)}/cancel`, { cancel_at_cycle_end: 1 });
  } catch (err) {
    // Already ended on Razorpay's side: bring our copy up to date instead of failing.
    if (err.razorpayStatus === 400) {
      await exports.sync(userId).catch(() => {});
      throw AppError.badRequest('This subscription can no longer be cancelled here. Reload to see its current state, or contact support.');
    }
    throw err;
  }
  await prisma.user.update({ where: { id: userId }, data: { subscriptionCancelAtPeriodEnd: true } });
  await audit.record({ type: 'subscription_cancel_requested', targetUserId: userId, meta: { provider: 'razorpay' } });
  return { cancelAtPeriodEnd: true };
};

// Ends a subscription immediately, for account deletion. Throws unless Razorpay confirms it is
// ended (a subscription already ended there counts), so the caller refuses to delete an account
// that would keep being billed.
exports.cancelNow = async (userId) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    omit: { razorpaySubscriptionId: false },
  });
  if (!user?.razorpaySubscriptionId || user.subscriptionStatus === 'canceled') return;
  const id = encodeURIComponent(user.razorpaySubscriptionId);
  try {
    await call('POST', `/subscriptions/${id}/cancel`, { cancel_at_cycle_end: 0 });
  } catch {
    try {
      const entity = await call('GET', `/subscriptions/${id}`);
      if (ENDED_STATUSES.includes(entity.status)) return;
      // Never paid (still `created`): it can be cancelled, and it holds no money, so a refusal is fine.
      if (entity.status === 'created') return;
    } catch {
      // fall through to the refusal below
    }
    throw new AppError('Could not cancel your subscription, so your account was not deleted. Try again, or contact support.', 502);
  }
};
