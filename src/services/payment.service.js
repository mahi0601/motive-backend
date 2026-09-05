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
    success_url: `${config.frontendUrl}/settings?upgrade=success`,
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

exports.handleWebhookEvent = async (event) => {
  if (event.type !== 'checkout.session.completed') return;

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
