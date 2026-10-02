// src/routes/payment.routes.js
// Only the (JSON, auth-protected) checkout-session route lives here. The
// webhook route is mounted separately in server.js — before the global JSON
// body parser — because Stripe signature verification needs the raw request body.
const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const PaymentController = require('../controllers/payment.controller');
const auth = require('../middlewares/auth.middleware');
const validate = require('../middlewares/validate.middleware');
const { createCheckoutSessionRules, changePlanRules } = require('../validators/payment.validator');

router.post(
  '/create-checkout-session',
  auth,
  createCheckoutSessionRules,
  validate,
  PaymentController.createCheckoutSession
);

// Each call can reach Stripe and changes what the account is billed, so it is capped
// well below the global limit (a real person switches plan about once).
const changePlanLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many attempts, try again later.' },
});
router.post('/change-plan', auth, changePlanLimiter, changePlanRules, validate, PaymentController.changePlan);

// Manage billing: Stripe's hosted Customer Portal (needs a billing account).
router.post('/portal', auth, PaymentController.createPortalSession);

// Reconciliation fallback — see payment.service.js#reconcileSession.
router.get('/session/:sessionId', auth, PaymentController.getCheckoutSession);

module.exports = router;
