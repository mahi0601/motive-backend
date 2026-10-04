// The payment gateways, behind one interface. Each entry says what the gateway can do, so the rest of
// the app asks "can it?" instead of knowing which gateway it is talking to:
//   portal      a hosted page to manage billing (Stripe only)
//   planSwitch  the in-app Studio -> Agency switch (Stripe only: the others cannot edit or prorate)
//   cancel      'portal' (cancel inside the gateway's page) or 'in_app' (the app's own Cancel button)
//   needsPhone  the checkout needs the buyer's phone number (Cashfree)
//   handoff     'redirect' (go to a URL) or 'sdk' (a script opens the checkout from a session id)
// A gateway appears for a currency only when it supports it AND its keys are configured, in the order
// from config.paymentOrder (first = preselected). Stripe is reached lazily to avoid a require cycle
// with payment.service.js, which owns the Stripe code.
const config = require('../../config/env');
const razorpay = require('../razorpay.service');
const paypal = require('../paypal.service');
const cashfree = require('../cashfree.service');

const stripe = () => require('../payment.service');

const inApp = { portal: false, planSwitch: false, cancel: 'in_app', needsPhone: false, handoff: 'redirect' };

const GATEWAYS = {
  stripe: {
    id: 'stripe',
    label: 'Stripe',
    currencies: ['usd', 'inr'],
    isConfigured: () => !!config.stripe.secretKey,
    capabilities: { portal: true, planSwitch: true, cancel: 'portal', needsPhone: false, handoff: 'redirect' },
    createCheckout: (user, plan, currency) => stripe().stripeCheckout(user, currency, plan),
    cancelNow: (userId) => stripe().cancelStripeSubscription(userId),
  },
  razorpay: {
    id: 'razorpay',
    label: 'Razorpay',
    currencies: ['inr'],
    isConfigured: razorpay.isConfigured,
    capabilities: inApp,
    createCheckout: async (user, plan) => ({ provider: 'razorpay', ...(await razorpay.createCheckout(user, plan)) }),
    sync: razorpay.sync,
    cancelAtPeriodEnd: razorpay.cancelAtPeriodEnd,
    cancelNow: razorpay.cancelNow,
  },
  paypal: {
    id: 'paypal',
    label: 'PayPal',
    currencies: ['usd'],
    isConfigured: paypal.isConfigured,
    capabilities: inApp,
    createCheckout: async (user, plan, currency) => ({ provider: 'paypal', ...(await paypal.createCheckout(user, plan, currency)) }),
    sync: paypal.sync,
    cancelAtPeriodEnd: paypal.cancelAtPeriodEnd,
    cancelNow: paypal.cancelNow,
  },
  cashfree: {
    id: 'cashfree',
    label: 'Cashfree',
    currencies: ['inr'],
    isConfigured: cashfree.isConfigured,
    capabilities: { ...inApp, needsPhone: true, handoff: 'sdk' },
    createCheckout: async (user, plan, currency, extras) => ({ provider: 'cashfree', ...(await cashfree.createCheckout(user, plan, currency, extras)) }),
    sync: cashfree.sync,
    cancelAtPeriodEnd: cashfree.cancelAtPeriodEnd,
    cancelNow: cashfree.cancelNow,
  },
};

exports.get = (id) => GATEWAYS[id] || null;
exports.ids = () => Object.keys(GATEWAYS);

// The gateways that can take this currency right now, in the configured order. One missing from the
// order list (a typo, or a gateway added later) is still offered, after the named ones.
exports.forCurrency = (currency) => {
  const usable = (g) => g && g.currencies.includes(currency) && g.isConfigured();
  const named = (config.paymentOrder[currency] || []).map((id) => GATEWAYS[id]).filter(usable);
  const rest = Object.values(GATEWAYS).filter((g) => usable(g) && !named.includes(g));
  return [...named, ...rest];
};

// What the billing card is told about a gateway: no keys, no internals.
exports.describe = (g) => ({ id: g.id, label: g.label, needsPhone: g.capabilities.needsPhone, handoff: g.capabilities.handoff });
