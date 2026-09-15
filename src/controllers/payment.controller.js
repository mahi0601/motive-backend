const PaymentService = require('../services/payment.service');
const UserService = require('../services/user.service');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const logger = require('../config/logger');

exports.createCheckoutSession = asyncHandler(async (req, res) => {
  const user = await UserService.getProfile(req.user.id);
  if (!user) throw AppError.notFound('User not found');

  const { url } = await PaymentService.createCheckoutSession(user, req.body.currency);
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
