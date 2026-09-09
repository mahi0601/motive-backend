const PaymentService = require('../services/payment.service');
const UserService = require('../services/user.service');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');

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
exports.webhook = asyncHandler(async (req, res) => {
  const signature = req.headers['stripe-signature'];

  let event;
  try {
    event = PaymentService.verifyWebhookEvent(req.body, signature);
  } catch (err) {
    console.error('⚠️  Stripe webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  await PaymentService.handleWebhookEvent(event);
  res.status(200).json({ received: true });
});
