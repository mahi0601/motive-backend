const Stripe = require('stripe');
const config = require('../config/env');
const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');

// Lazily constructed — throws only when a payment route is actually hit without
// keys configured, instead of crashing the whole app at boot.
let stripe = null;
const getStripe = () => {
  if (!config.stripe.secretKey) throw new AppError('Payments are not configured', 500);
  if (!stripe) stripe = new Stripe(config.stripe.secretKey);
  return stripe;
};

// One-time "Pro" upgrade — Stripe Checkout in `payment` mode (not a subscription).
// `currency` picks which price/currency the buyer pays in; `automatic_payment_methods`
// (rather than a hardcoded `payment_method_types` list) lets Stripe show every method
// that's both enabled in the Dashboard and valid for that currency/the account's
// country — cards plus wallets (Google Pay, Apple Pay, Link) for any currency, and
// UPI (PhonePe, GPay UPI, Paytm) for INR *if* the Stripe account is India-registered.
exports.createCheckoutSession = async (user, currency = 'usd') => {
  if (user.isPro) throw AppError.badRequest('Already upgraded to Pro');

  const pricing = config.stripe.proPricing[currency];
  if (!pricing) throw AppError.badRequest(`Unsupported currency: ${currency}`);

  const client = getStripe();
  const session = await client.checkout.sessions.create({
    mode: 'payment',
    automatic_payment_methods: { enabled: true },
    customer_email: user.email,
    client_reference_id: user.id,
    line_items: [
      {
        price_data: {
          currency,
          product_data: { name: 'Motive Pro — lifetime upgrade' },
          unit_amount: pricing.amount,
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
const RELEVANT_EVENT_TYPES = ['checkout.session.completed', 'checkout.session.async_payment_succeeded'];

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

  if (!RELEVANT_EVENT_TYPES.includes(event.type)) return;

  const session = event.data.object;
  if (session.payment_status !== 'paid') return;

  const userId = session.metadata?.userId || session.client_reference_id;
  if (!userId) return;

  // updateMany (not update) so a stale/forged webhook userId no-ops instead of throwing.
  await prisma.user.updateMany({
    where: { id: userId },
    data: { isPro: true, ...(session.customer ? { stripeCustomerId: session.customer } : {}) },
  });
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

  if (session.payment_status !== 'paid') {
    return { isPro: false, paymentStatus: session.payment_status };
  }

  await prisma.user.updateMany({
    where: { id: userId },
    data: { isPro: true, ...(session.customer ? { stripeCustomerId: session.customer } : {}) },
  });
  return { isPro: true, paymentStatus: session.payment_status };
};
