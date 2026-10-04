// Cashfree: monthly subscriptions paid in INR (UPI, cards, eNACH where the buyer's bank allows),
// for buyers in India. Plugs into the same user columns every gateway uses (subscriptionState.js).
//
// Plain REST over fetch. How it differs from the others, because it shapes this file:
//  - Creating a subscription returns a session id, NOT a URL: the browser opens Cashfree's
//    checkout with its JS SDK (see the frontend billing card).
//  - Cashfree requires the buyer's phone number. It is passed through and never stored here.
//  - Amounts are in rupees (decimal), not paise, and the plan is sent inline with the subscription.
//  - Webhooks are signed with HMAC-SHA256 over `timestamp + raw body` using the client secret.
//  - Like PayPal, a webhook is only a POINTER: the subscription is re-read from Cashfree and that is
//    what is applied.
//  - A mandate can be ACTIVE before its first debit, so access is granted only on EVIDENCE of a
//    successful payment (a signed payment-success event, or a successful payment on the list), never
//    on a status alone; and an unknown status never takes access away from someone already paying.
//  - Cancelling ends billing at once (cycle-end cancellation is not documented), so the app records
//    "paid until <date>" and keeps access to it; jobs/cleanup.js ends it.
const crypto = require('crypto');
const config = require('../config/env');
const logger = require('../config/logger');
const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const audit = require('./audit.service');
const { PAID_PLANS, PLAN_NAMES } = require('../utils/plans');
const { applyGatewayState, PAYING } = require('./subscriptionState');

const BASES = { sandbox: 'https://sandbox.cashfree.com', production: 'https://api.cashfree.com' };
const MAX_WEBHOOK_AGE_MS = 10 * 60 * 1000;

exports.isConfigured = () => !!(config.cashfree.clientId && config.cashfree.clientSecret);

const fail = (message, status, code) => {
  const err = new AppError(message, 502);
  err.cashfreeStatus = status;
  err.cashfreeCode = code;
  return err;
};

const call = async (method, path, body) => {
  if (!exports.isConfigured()) throw new AppError('Payments are not configured', 503);
  let res;
  try {
    res = await fetch(`${BASES[config.cashfree.mode]}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-client-id': config.cashfree.clientId,
        'x-client-secret': config.cashfree.clientSecret,
        'x-api-version': config.cashfree.apiVersion,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    logger.warn('cashfree request failed', { path, err: err?.message });
    throw fail('Could not reach the payment provider. Try again in a moment.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    logger.warn('cashfree error', { method, path, status: res.status, code: data?.code || data?.type });
    throw fail('The payment provider could not complete that. Try again, or contact support.', res.status, data?.code);
  }
  return data;
};
exports._call = call;

// An Indian mobile number as ten digits, from "98765 43210", "+91 98765-43210" or "09876543210".
// null when it is not one. Exported for the frontend-facing validator and the tests.
exports.normalizePhone = (value) => {
  if (typeof value !== 'string') return null;
  const digits = value.replace(/[\s-]/g, '').replace(/^\+?91/, '').replace(/^0/, '');
  return /^[6-9]\d{9}$/.test(digits) ? digits : null;
};

const priceOf = (plan) => {
  const pricing = config.stripe.plans[plan]?.inr;
  if (!pricing) throw AppError.badRequest('That plan is not available in INR');
  return pricing.amount; // paise
};
const rupees = (paise) => Number((paise / 100).toFixed(2));

// ---- checkout ---------------------------------------------------------------------------

// Creates the subscription and returns what the browser needs to open Cashfree's checkout. A
// buyer who clicks twice makes two unauthorised subscriptions; neither holds money, and if both
// were ever paid the second is cancelled (subscriptionState.js).
exports.createCheckout = async (user, plan, currency = 'inr', { phone } = {}) => {
  if (user.isPro) throw AppError.badRequest('Already upgraded to Pro');
  if (String(currency).toLowerCase() !== 'inr') throw AppError.badRequest('Cashfree takes INR only');
  if (!PAID_PLANS.includes(plan)) throw AppError.badRequest(`Unsupported plan: ${plan}`);
  const customerPhone = exports.normalizePhone(phone);
  if (!customerPhone) throw AppError.badRequest('Enter a valid 10-digit Indian mobile number.');
  const amount = rupees(priceOf(plan));

  const subscriptionId = `cg_${user.id}_${Date.now().toString(36)}`;
  const created = await call('POST', '/pg/subscriptions', {
    subscription_id: subscriptionId,
    customer_details: { customer_name: String(user.name || 'Clientglass customer').slice(0, 100), customer_email: user.email, customer_phone: customerPhone },
    plan_details: {
      plan_name: `Clientglass ${PLAN_NAMES[plan]}`.slice(0, 40),
      plan_type: 'PERIODIC',
      plan_amount: amount,
      plan_max_amount: amount,
      plan_max_cycles: config.cashfree.maxCycles,
      plan_currency: 'INR',
      plan_intervals: 1,
      plan_interval_type: 'MONTH',
    },
    subscription_meta: { return_url: `${config.frontendUrl}/settings?upgrade=pending&gateway=cashfree` },
    subscription_tags: { userId: user.id, plan },
  });
  if (!created.subscription_session_id) throw fail('The payment provider did not return a checkout session. Try again.');

  // Remembered so `sync` can ask Cashfree about it on return, before any webhook. Grants nothing.
  await prisma.user.update({ where: { id: user.id }, data: { cashfreeSubscriptionId: subscriptionId, paymentProvider: 'cashfree' } });
  return { sessionId: created.subscription_session_id, mode: config.cashfree.mode };
};

// ---- applying what Cashfree says --------------------------------------------------------

const dateOf = (iso) => (iso && !Number.isNaN(Date.parse(iso)) ? new Date(iso) : null);

// A successful payment on the subscription's payment list. The list's exact shape is not pinned
// down by Cashfree's docs, so an array, or an object holding one, is accepted; anything else (or
// an error) is "no evidence", which is the safe answer: nothing is granted on it.
const hasSuccessfulPayment = async (id) => {
  try {
    const data = await call('GET', `/pg/subscriptions/${encodeURIComponent(id)}/payments`);
    const list = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : Array.isArray(data?.payments) ? data.payments : [];
    return list.some((p) => String(p?.payment_status ?? p?.status ?? '').toUpperCase() === 'SUCCESS');
  } catch {
    return false;
  }
};

// Maps a fetched subscription onto the shared state. `paidEvidence`: a signed payment-success event
// or a successful payment found on the list. `alreadyPaying`: the user is already stored as paying
// on this very subscription, so a status we cannot read or a failed read must not revoke access.
const stateOf = (entity, { paidEvidence, alreadyPaying, paymentFailed }) => {
  const status = String(entity.subscription_status || '').toUpperCase();
  const base = { periodEnd: dateOf(entity.next_schedule_date), plan: PAID_PLANS.includes(entity.subscription_tags?.plan) ? entity.subscription_tags.plan : null };
  if (status === 'ACTIVE') {
    const paid = paidEvidence || alreadyPaying;
    if (!paid) return { ...base, status: 'incomplete', paid: false, inFlight: true, ended: false };
    return { ...base, status: paymentFailed ? 'past_due' : 'active', paid: true, inFlight: false, ended: false };
  }
  if (status === 'INITIALIZED' || status === 'BANK_APPROVAL_PENDING') return { ...base, status: 'incomplete', paid: false, inFlight: true, ended: false };
  if (status === 'PAUSED') return { ...base, status: 'paused', paid: false, inFlight: false, ended: false };
  if (status === 'HALTED' || status === 'FAILED') return { ...base, status: 'unpaid', paid: false, inFlight: false, ended: true };
  if (status === 'CANCELLED' || status === 'COMPLETED') return { ...base, status: 'canceled', paid: false, inFlight: false, ended: true };
  // A status we do not know: change nothing about access, so a new Cashfree status never cuts anyone off.
  return { ...base, status: alreadyPaying ? 'active' : String(status || 'unknown').toLowerCase(), paid: alreadyPaying, inFlight: false, ended: false };
};

const cancelOnCashfree = (id) => call('POST', `/pg/subscriptions/${encodeURIComponent(id)}/manage`, { subscription_id: id, action: 'CANCEL' });

const fetchSubscription = (id) => call('GET', `/pg/subscriptions/${encodeURIComponent(id)}`);

const applyEntity = async (entity, { signedPaymentSuccess = false, paymentFailed = false } = {}) => {
  const id = entity.subscription_id;
  const stored = id
    ? await prisma.user.findFirst({ where: { cashfreeSubscriptionId: id }, select: { isPro: true, subscriptionStatus: true } })
    : null;
  const alreadyPaying = !!stored && PAYING.includes(stored.subscriptionStatus);
  // Evidence the buyer has paid: a signed payment-success event, or (for an ACTIVE subscription not
  // yet known to be paying) a successful payment on the list.
  let paidEvidence = signedPaymentSuccess;
  if (!paidEvidence && String(entity.subscription_status).toUpperCase() === 'ACTIVE' && !alreadyPaying) paidEvidence = await hasSuccessfulPayment(id);
  return applyGatewayState({
    provider: 'cashfree',
    idColumn: 'cashfreeSubscriptionId',
    id,
    userHint: entity.subscription_tags?.userId,
    state: stateOf(entity, { paidEvidence, alreadyPaying, paymentFailed }),
    cancelDuplicate: cancelOnCashfree,
    honourPaidUntil: true,
  });
};

// ---- webhook ----------------------------------------------------------------------------

// HMAC-SHA256 over `timestamp + raw body` with the client secret, base64, compared in constant time.
// Throws on a bad, missing or (when the timestamp is a number) stale signature: the controller
// answers 400. Returns the parsed event.
exports.verifyWebhook = (rawBody, signature, timestamp) => {
  const secret = config.cashfree.clientSecret;
  if (!secret) throw new AppError('Cashfree is not configured', 500);
  if (typeof signature !== 'string' || !signature || typeof timestamp !== 'string' || !timestamp) throw new Error('Missing signature');
  const text = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
  const expected = crypto.createHmac('sha256', secret).update(timestamp + text).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('Invalid signature');
  // A replay of an old, genuine message. Only checked when the timestamp is an epoch number; the
  // signature has already proved it is Cashfree's, and the ledger below catches an exact repeat.
  if (/^\d+$/.test(timestamp)) {
    const ms = timestamp.length > 11 ? Number(timestamp) : Number(timestamp) * 1000;
    if (Math.abs(Date.now() - ms) > MAX_WEBHOOK_AGE_MS) throw new Error('Stale webhook');
  }
  return JSON.parse(text);
};

// Where the subscription id is in an event. Cashfree's docs show it inside `subscription_details`
// for status events and beside the payment for payment events; both are looked for.
const subscriptionIdOf = (event) => {
  const data = event?.data || {};
  return data.subscription_details?.subscription_id || data.subscription_id || data.payment_details?.subscription_id;
};

exports.handleWebhook = async (event, { timestamp = '', rawBody = '' } = {}) => {
  const id = `cashfree:${crypto.createHash('sha256').update(`${timestamp}${Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody}` || JSON.stringify(event)).digest('hex')}`;
  const type = String(event?.type || 'unknown');
  try {
    await prisma.webhookEvent.create({ data: { stripeEventId: id, type: type.slice(0, 100) } });
  } catch (err) {
    if (err.code === 'P2002') return;
    throw err;
  }
  try {
    const subscriptionId = type.startsWith('SUBSCRIPTION_') ? subscriptionIdOf(event) : undefined;
    if (subscriptionId) {
      await applyEntity(await fetchSubscription(subscriptionId), {
        signedPaymentSuccess: type === 'SUBSCRIPTION_PAYMENT_SUCCESS',
        paymentFailed: type === 'SUBSCRIPTION_PAYMENT_FAILED',
      });
    }
  } catch (err) {
    await prisma.webhookEvent.deleteMany({ where: { stripeEventId: id } }).catch(() => {});
    throw err;
  }
};

// ---- the buyer's side -------------------------------------------------------------------

exports.sync = async (userId) => {
  const user = await prisma.user.findUnique({ where: { id: userId }, omit: { cashfreeSubscriptionId: false } });
  if (!user) throw AppError.notFound('User not found');
  if (user.cashfreeSubscriptionId) {
    const entity = await fetchSubscription(user.cashfreeSubscriptionId);
    // Only ever apply a subscription that was made for this account.
    if (entity.subscription_tags?.userId === userId) await applyEntity(entity);
  }
  const fresh = await prisma.user.findUnique({ where: { id: userId }, select: { isPro: true, subscriptionStatus: true } });
  return { isPro: !!fresh?.isPro, status: fresh?.subscriptionStatus ?? null };
};

// Cashfree stops billing as soon as this is called, so the end of the paid period is read first and
// kept; access runs to that date and jobs/cleanup.js ends it. Not undoable: the buyer subscribes
// again afterwards (the UI says so).
exports.cancelAtPeriodEnd = async (userId) => {
  const user = await prisma.user.findUnique({ where: { id: userId }, omit: { cashfreeSubscriptionId: false } });
  if (!user?.cashfreeSubscriptionId || user.paymentProvider !== 'cashfree') throw AppError.badRequest('There is no subscription to cancel here');
  if (!PAYING.includes(user.subscriptionStatus)) throw AppError.badRequest('There is no active subscription to cancel');
  if (user.subscriptionCancelAtPeriodEnd) return { cancelAtPeriodEnd: true };

  let periodEnd = user.proPeriodEnd;
  try {
    periodEnd = dateOf((await fetchSubscription(user.cashfreeSubscriptionId)).next_schedule_date) ?? periodEnd;
  } catch {
    // The date already stored is used; cancelling must not depend on this read.
  }
  try {
    await cancelOnCashfree(user.cashfreeSubscriptionId);
  } catch (err) {
    if (err.cashfreeStatus === 400 || err.cashfreeStatus === 404 || err.cashfreeStatus === 422) {
      await exports.sync(userId).catch(() => {});
      throw AppError.badRequest('This subscription can no longer be cancelled here. Reload to see its current state, or contact support.');
    }
    throw err;
  }
  await prisma.user.update({ where: { id: userId }, data: { subscriptionCancelAtPeriodEnd: true, proPeriodEnd: periodEnd ?? new Date() } });
  await audit.record({ type: 'subscription_cancel_requested', targetUserId: userId, meta: { provider: 'cashfree' } });
  return { cancelAtPeriodEnd: true };
};

// Ends it immediately, for account deletion. Throws unless Cashfree confirms it is ended.
exports.cancelNow = async (userId) => {
  const user = await prisma.user.findUnique({ where: { id: userId }, omit: { cashfreeSubscriptionId: false } });
  if (!user?.cashfreeSubscriptionId || user.subscriptionStatus === 'canceled') return;
  try {
    await cancelOnCashfree(user.cashfreeSubscriptionId);
  } catch {
    try {
      const entity = await fetchSubscription(user.cashfreeSubscriptionId);
      // Already over, or never authorised by the buyer (so it holds no money).
      if (['CANCELLED', 'COMPLETED', 'INITIALIZED'].includes(String(entity.subscription_status).toUpperCase())) return;
    } catch {
      // fall through to the refusal below
    }
    throw new AppError('Could not cancel your subscription, so your account was not deleted. Try again, or contact support.', 502);
  }
};
