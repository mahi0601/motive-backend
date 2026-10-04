// PayPal: monthly subscriptions paid in USD (PayPal does not take INR in India, so this is
// USD only). Plugs into the same user columns every gateway uses; see subscriptionState.js.
//
// Plain REST over fetch with an OAuth2 client-credentials token. How it differs from the others:
//  - Product -> plan -> subscription. The product and one plan per price are created on demand and
//    remembered (ProviderPlan), so a price change makes a new plan and never edits one in use.
//  - The buyer approves at a PayPal URL and PayPal sends them back to our `return_url`.
//  - A webhook is only a POINTER. It is verified (PayPal checks its own signature), then the
//    subscription is re-read from PayPal and THAT is applied, so a forged, reordered or oddly shaped
//    payload can never grant access.
//  - Cancelling ends billing at once, so the app records "paid until <date>" and keeps access to that
//    date (jobs/cleanup.js ends it).
const crypto = require('crypto');
const config = require('../config/env');
const logger = require('../config/logger');
const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const audit = require('./audit.service');
const { PAID_PLANS, PLAN_NAMES } = require('../utils/plans');
const { applyGatewayState, PAYING } = require('./subscriptionState');

const BASES = { sandbox: 'https://api-m.sandbox.paypal.com', live: 'https://api-m.paypal.com' };
const CURRENCY = 'usd';
const REQUEST_ID_WINDOW_MS = 10 * 60 * 1000;

exports.isConfigured = () => !!(config.paypal.clientId && config.paypal.clientSecret);

// The access token, reused until a minute before it expires. Module-scoped; tests reset it.
let cachedToken = null;
exports._resetToken = () => {
  cachedToken = null;
};

const fail = (message, status, code) => {
  const err = new AppError(message, 502);
  err.paypalStatus = status;
  err.paypalCode = code;
  return err;
};

const request = async (method, path, { body, headers = {}, token, form } = {}) => {
  let res;
  try {
    res = await fetch(`${BASES[config.paypal.mode]}${path}`, {
      method,
      headers: { ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: form ?? (body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    logger.warn('paypal request failed', { path, err: err?.message });
    throw fail('Could not reach the payment provider. Try again in a moment.');
  }
  const data = await res.json().catch(() => ({})); // some calls answer 204 with no body
  if (!res.ok) {
    logger.warn('paypal error', { method, path, status: res.status, code: data?.name });
    throw fail('The payment provider could not complete that. Try again, or contact support.', res.status, data?.name);
  }
  return data;
};

const getToken = async () => {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60 * 1000) return cachedToken.value;
  const basic = Buffer.from(`${config.paypal.clientId}:${config.paypal.clientSecret}`).toString('base64');
  const data = await request('POST', '/v1/oauth2/token', { form: 'grant_type=client_credentials', headers: { Authorization: `Basic ${basic}` } });
  if (!data.access_token) throw fail('The payment provider did not authorise this request. Check the PayPal keys.');
  cachedToken = { value: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) || 300) * 1000 };
  return cachedToken.value;
};

const call = async (method, path, opts = {}) => {
  if (!exports.isConfigured()) throw new AppError('Payments are not configured', 503);
  return request(method, path, { ...opts, token: await getToken() });
};
exports._call = call;

const priceOf = (plan) => {
  const pricing = config.stripe.plans[plan]?.[CURRENCY];
  if (!pricing) throw AppError.badRequest('That plan is not available in USD');
  return pricing.amount; // cents
};

// ---- product and plan, created once and remembered -------------------------------------

const remembered = async (plan, currency, amount, create) => {
  const key = { provider: 'paypal', plan, currency, amount };
  const found = await prisma.providerPlan.findUnique({ where: { provider_plan_currency_amount: key } });
  if (found) return found.providerPlanId;
  const id = await create();
  try {
    await prisma.providerPlan.create({ data: { ...key, providerPlanId: id } });
    return id;
  } catch (err) {
    if (err.code !== 'P2002') throw err;
    return (await prisma.providerPlan.findUnique({ where: { provider_plan_currency_amount: key } })).providerPlanId;
  }
};

const productId = () =>
  remembered('_product', CURRENCY, 0, async () => (await call('POST', '/v1/catalogs/products', { body: { name: 'Clientglass', type: 'SERVICE', category: 'SOFTWARE' } })).id);

// The plan is looked up first; the product is only needed (and only created) when a plan has to be made.
const planId = (plan, cents) =>
  remembered(plan, CURRENCY, cents, async () => {
    const product = await productId();
    const created = await call('POST', '/v1/billing/plans', {
      body: {
        product_id: product,
        name: `Clientglass ${PLAN_NAMES[plan]} — monthly`,
        status: 'ACTIVE',
        billing_cycles: [
          {
            frequency: { interval_unit: 'MONTH', interval_count: 1 },
            tenure_type: 'REGULAR',
            sequence: 1,
            total_cycles: 0, // until cancelled
            pricing_scheme: { fixed_price: { value: (cents / 100).toFixed(2), currency_code: CURRENCY.toUpperCase() } },
          },
        ],
        payment_preferences: { auto_bill_outstanding: true, setup_fee_failure_action: 'CANCEL', payment_failure_threshold: 3 },
      },
    });
    return created.id;
  });

// ---- checkout ---------------------------------------------------------------------------

// Starts a subscription and returns PayPal's approval URL. The request id makes a double-click (or
// a retry after a timeout) within ten minutes return the SAME subscription instead of a second one.
exports.createCheckout = async (user, plan, currency = CURRENCY) => {
  if (user.isPro) throw AppError.badRequest('Already upgraded to Pro');
  if (String(currency).toLowerCase() !== CURRENCY) throw AppError.badRequest('PayPal takes USD only');
  if (!PAID_PLANS.includes(plan)) throw AppError.badRequest(`Unsupported plan: ${plan}`);
  const cents = priceOf(plan);

  const plan_id = await planId(plan, cents);
  const window = Math.floor(Date.now() / REQUEST_ID_WINDOW_MS);
  const subscription = await call('POST', '/v1/billing/subscriptions', {
    headers: { 'PayPal-Request-Id': `cg-${user.id}-${plan}-${cents}-${window}`, Prefer: 'return=representation' },
    body: {
      plan_id,
      custom_id: user.id,
      application_context: {
        brand_name: 'Clientglass',
        user_action: 'SUBSCRIBE_NOW',
        shipping_preference: 'NO_SHIPPING',
        return_url: `${config.frontendUrl}/settings?upgrade=pending&gateway=paypal`,
        cancel_url: `${config.frontendUrl}/settings?upgrade=cancelled`,
      },
    },
  });
  const approve = (subscription.links || []).find((l) => l.rel === 'approve')?.href;
  if (!subscription.id || !approve) throw fail('The payment provider did not return an approval link. Try again.');

  // Remembered now so `sync` can ask PayPal about it when the buyer comes back, before any webhook.
  // It grants nothing: only a paid status does that.
  await prisma.user.update({ where: { id: user.id }, data: { paypalSubscriptionId: subscription.id, paymentProvider: 'paypal' } });
  return { url: approve };
};

// ---- applying what PayPal says ----------------------------------------------------------

const dateOf = (iso) => (iso && !Number.isNaN(Date.parse(iso)) ? new Date(iso) : null);

const planFromEntity = async (entity) => {
  const row = entity.plan_id ? await prisma.providerPlan.findFirst({ where: { provider: 'paypal', providerPlanId: entity.plan_id } }) : null;
  return row && PAID_PLANS.includes(row.plan) ? row.plan : null; // null = keep what the user has
};

const stateOf = async (entity) => {
  const status = entity.status;
  const failed = Number(entity.billing_info?.failed_payments_count) > 0;
  const base = { periodEnd: dateOf(entity.billing_info?.next_billing_time), plan: await planFromEntity(entity) };
  if (status === 'ACTIVE') return { ...base, status: failed ? 'past_due' : 'active', paid: true, inFlight: false, ended: false };
  if (status === 'APPROVAL_PENDING' || status === 'APPROVED') return { ...base, status: 'incomplete', paid: false, inFlight: true, ended: false };
  if (status === 'SUSPENDED') return { ...base, status: 'unpaid', paid: false, inFlight: false, ended: true };
  if (status === 'CANCELLED' || status === 'EXPIRED') return { ...base, status: 'canceled', paid: false, inFlight: false, ended: true };
  return { ...base, status: String(status || 'unknown').toLowerCase(), paid: false, inFlight: false, ended: false };
};

const cancelOnPaypal = (id) => call('POST', `/v1/billing/subscriptions/${encodeURIComponent(id)}/cancel`, { body: { reason: 'Cancelled in Clientglass' } });

const applyEntity = async (entity) =>
  applyGatewayState({
    provider: 'paypal',
    idColumn: 'paypalSubscriptionId',
    id: entity.id,
    userHint: entity.custom_id,
    state: await stateOf(entity),
    cancelDuplicate: cancelOnPaypal,
    honourPaidUntil: true,
  });

const fetchSubscription = (id) => call('GET', `/v1/billing/subscriptions/${encodeURIComponent(id)}`);

// ---- webhook ----------------------------------------------------------------------------

// Has PayPal confirm the signature: the transmission headers, our webhook id and the event exactly
// as received (spliced in as raw text, because re-serialising it can break the check). Throws on
// anything but SUCCESS, so the controller answers 400.
exports.verifyWebhook = async (rawBody, headers = {}) => {
  if (!config.paypal.webhookId) throw new AppError('PayPal webhook id not configured', 500);
  const h = (name) => headers[name];
  const parts = {
    auth_algo: h('paypal-auth-algo'),
    cert_url: h('paypal-cert-url'),
    transmission_id: h('paypal-transmission-id'),
    transmission_sig: h('paypal-transmission-sig'),
    transmission_time: h('paypal-transmission-time'),
  };
  if (Object.values(parts).some((v) => typeof v !== 'string' || !v)) throw new Error('Missing PayPal signature headers');
  const text = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
  const event = JSON.parse(text); // also proves it is JSON before it is spliced into one
  const body = `{${Object.entries({ ...parts, webhook_id: config.paypal.webhookId })
    .map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`)
    .join(',')},"webhook_event":${text}}`;
  const result = await call('POST', '/v1/notifications/verify-webhook-signature', { body });
  if (result.verification_status !== 'SUCCESS') throw new Error('Invalid signature');
  return event;
};

// Which subscription an event is about. Subscription events carry it as `resource.id`; a completed
// sale carries it as `resource.billing_agreement_id`. Anything else is not ours to act on.
const subscriptionIdOf = (event) => {
  const type = String(event?.event_type || '');
  if (type.startsWith('BILLING.SUBSCRIPTION.')) return event.resource?.id;
  if (type.startsWith('PAYMENT.SALE.')) return event.resource?.billing_agreement_id;
  return undefined;
};

exports.handleWebhook = async (event) => {
  const id = `paypal:${event.id || crypto.createHash('sha256').update(JSON.stringify(event)).digest('hex')}`;
  try {
    await prisma.webhookEvent.create({ data: { stripeEventId: id, type: String(event.event_type || 'unknown').slice(0, 100) } });
  } catch (err) {
    if (err.code === 'P2002') return;
    throw err;
  }
  try {
    const subscriptionId = subscriptionIdOf(event);
    if (subscriptionId) await applyEntity(await fetchSubscription(subscriptionId));
  } catch (err) {
    await prisma.webhookEvent.deleteMany({ where: { stripeEventId: id } }).catch(() => {});
    throw err;
  }
};

// ---- the buyer's side -------------------------------------------------------------------

exports.sync = async (userId) => {
  const user = await prisma.user.findUnique({ where: { id: userId }, omit: { paypalSubscriptionId: false } });
  if (!user) throw AppError.notFound('User not found');
  if (user.paypalSubscriptionId) {
    const entity = await fetchSubscription(user.paypalSubscriptionId);
    // Only ever apply a subscription that was made for this account.
    if (entity.custom_id === userId) await applyEntity(entity);
  }
  const fresh = await prisma.user.findUnique({ where: { id: userId }, select: { isPro: true, subscriptionStatus: true } });
  return { isPro: !!fresh?.isPro, status: fresh?.subscriptionStatus ?? null };
};

// PayPal stops billing the moment this is called, so the end of the paid period is read first and
// kept: access runs to that date and jobs/cleanup.js ends it. Not undoable (PayPal cannot reactivate
// it for the merchant), so the buyer subscribes again afterwards (the UI says so).
exports.cancelAtPeriodEnd = async (userId) => {
  const user = await prisma.user.findUnique({ where: { id: userId }, omit: { paypalSubscriptionId: false } });
  if (!user?.paypalSubscriptionId || user.paymentProvider !== 'paypal') throw AppError.badRequest('There is no subscription to cancel here');
  if (!PAYING.includes(user.subscriptionStatus)) throw AppError.badRequest('There is no active subscription to cancel');
  if (user.subscriptionCancelAtPeriodEnd) return { cancelAtPeriodEnd: true };

  let periodEnd = user.proPeriodEnd;
  try {
    periodEnd = dateOf((await fetchSubscription(user.paypalSubscriptionId)).billing_info?.next_billing_time) ?? periodEnd;
  } catch {
    // The date already stored is used; cancelling must not depend on this read.
  }
  try {
    await cancelOnPaypal(user.paypalSubscriptionId);
  } catch (err) {
    if (err.paypalStatus === 422 || err.paypalStatus === 404) {
      await exports.sync(userId).catch(() => {});
      throw AppError.badRequest('This subscription can no longer be cancelled here. Reload to see its current state, or contact support.');
    }
    throw err;
  }
  await prisma.user.update({ where: { id: userId }, data: { subscriptionCancelAtPeriodEnd: true, proPeriodEnd: periodEnd ?? new Date() } });
  await audit.record({ type: 'subscription_cancel_requested', targetUserId: userId, meta: { provider: 'paypal' } });
  return { cancelAtPeriodEnd: true };
};

// Ends it immediately, for account deletion. Throws unless PayPal confirms it is ended.
exports.cancelNow = async (userId) => {
  const user = await prisma.user.findUnique({ where: { id: userId }, omit: { paypalSubscriptionId: false } });
  if (!user?.paypalSubscriptionId || user.subscriptionStatus === 'canceled') return;
  try {
    await cancelOnPaypal(user.paypalSubscriptionId);
  } catch {
    try {
      const entity = await fetchSubscription(user.paypalSubscriptionId);
      // Already over, or never approved by the buyer (so it holds no money): nothing is left to bill.
      // APPROVED is NOT safe: the buyer has approved and billing can start at any moment.
      if (['CANCELLED', 'EXPIRED', 'APPROVAL_PENDING'].includes(entity.status)) return;
    } catch {
      // fall through to the refusal below
    }
    throw new AppError('Could not cancel your subscription, so your account was not deleted. Try again, or contact support.', 502);
  }
};
