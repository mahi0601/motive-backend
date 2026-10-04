const PaymentService = require('../services/payment.service');
const RazorpayService = require('../services/razorpay.service');
const PaypalService = require('../services/paypal.service');
const CashfreeService = require('../services/cashfree.service');
const UserService = require('../services/user.service');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const logger = require('../config/logger');

exports.createCheckoutSession = asyncHandler(async (req, res) => {
  const user = await UserService.getProfile(req.user.id);
  if (!user) throw AppError.notFound('User not found');

  const result = await PaymentService.createCheckoutSession(user, req.body.currency, req.body.plan, {
    provider: req.body.provider,
    phone: req.body.phone,
  });
  // { provider, url } to redirect to, or { provider, sessionId, mode } for a gateway opened by an SDK.
  res.status(200).json({ success: true, ...result });
});

// Which gateways take each currency right now, in the order to offer them (an empty list =
// unavailable), so the billing card can show a "Pay with" choice or say so before a click.
exports.getOptions = asyncHandler(async (req, res) => {
  res.status(200).json({ success: true, options: PaymentService.getOptions() });
});

// The gateways with no redirect back and no hosted billing page (Razorpay, PayPal, Cashfree): the
// app asks for the current state when the buyer returns, and cancels from here.
exports.syncPayment = asyncHandler(async (req, res) => {
  const result = await PaymentService.syncForUser(req.user.id);
  res.status(200).json({ success: true, ...result });
});

exports.cancelSubscription = asyncHandler(async (req, res) => {
  const result = await PaymentService.cancelForUser(req.user.id);
  res.status(200).json({ success: true, ...result });
});

// Studio -> Agency on the existing subscription (see payment.service.js#changePlan).
exports.changePlan = asyncHandler(async (req, res) => {
  const { tier } = await PaymentService.changePlan(req.user.id, req.body.plan);
  res.status(200).json({ success: true, tier });
});

// Stripe's hosted Customer Portal — update card, view invoices, cancel.
exports.createPortalSession = asyncHandler(async (req, res) => {
  const { url } = await PaymentService.createPortalSession(req.user.id);
  res.status(200).json({ success: true, url });
});

// Fallback for the success-redirect: confirms (and backfills if needed)
// isPro directly from Stripe, in case the webhook was delayed or dropped.
exports.getCheckoutSession = asyncHandler(async (req, res) => {
  const result = await PaymentService.reconcileSession(req.params.sessionId, req.user.id);
  res.status(200).json({ success: true, ...result });
});

// Mounted with express.raw() ahead of the global JSON body parser (see server.js) —
// Stripe's signature check needs the exact raw bytes, not the re-serialized JSON.
//
// The two responses below deliberately don't use this codebase's usual
// { success, ... } envelope — this endpoint is called by Stripe, not our own
// frontend, and both shapes follow Stripe's own documented webhook
// conventions instead: a plain-text 400 body on a signature failure, and
// `{ received: true }` (Stripe's own example payload) on success.
exports.webhook = asyncHandler(async (req, res) => {
  const signature = req.headers['stripe-signature'];

  let event;
  try {
    event = PaymentService.verifyWebhookEvent(req.body, signature);
  } catch (err) {
    // Was console-only — invisible to Sentry. A signature failure in
    // production usually means a misconfigured STRIPE_WEBHOOK_SECRET after
    // a redeploy (a real operational problem worth alerting on), not just
    // noise, so this is reported rather than treated as routine.
    logger.error('Stripe webhook signature verification failed', err);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  await PaymentService.handleWebhookEvent(event);
  res.status(200).json({ received: true });
});

// Razorpay's webhook: raw body (see app.js), HMAC-signed with the dashboard webhook secret.
// Like Stripe's it is called by the provider, so it uses the provider's conventions rather
// than this app's { success } envelope: a plain-text 400 on a bad signature, { received: true }
// on success, and a 5xx on a processing failure so Razorpay retries.
exports.razorpayWebhook = asyncHandler(async (req, res) => {
  let event;
  try {
    event = RazorpayService.verifyWebhook(req.body, req.headers['x-razorpay-signature']);
  } catch (err) {
    logger.error('Razorpay webhook signature verification failed', err);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  await RazorpayService.handleWebhook(event, { eventId: req.headers['x-razorpay-event-id'], rawBody: req.body });
  res.status(200).json({ received: true });
});

// PayPal's webhook: raw body, verified by asking PayPal to check its own signature. Provider
// conventions again: plain-text 400 on a bad signature, { received: true } on success, 5xx to retry.
exports.paypalWebhook = asyncHandler(async (req, res) => {
  let event;
  try {
    event = await PaypalService.verifyWebhook(req.body, req.headers);
  } catch (err) {
    logger.error('PayPal webhook signature verification failed', err);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  await PaypalService.handleWebhook(event);
  res.status(200).json({ received: true });
});

// Cashfree's webhook: raw body, HMAC of `timestamp + body` with the client secret.
exports.cashfreeWebhook = asyncHandler(async (req, res) => {
  const timestamp = req.headers['x-webhook-timestamp'];
  let event;
  try {
    event = CashfreeService.verifyWebhook(req.body, req.headers['x-webhook-signature'], timestamp);
  } catch (err) {
    logger.error('Cashfree webhook signature verification failed', err);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  await CashfreeService.handleWebhook(event, { timestamp, rawBody: req.body });
  res.status(200).json({ received: true });
});
