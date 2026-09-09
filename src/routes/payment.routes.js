// src/routes/payment.routes.js
// Only the (JSON, auth-protected) checkout-session route lives here. The
// webhook route is mounted separately in server.js — before the global JSON
// body parser — because Stripe signature verification needs the raw request body.
const express = require('express');
const router = express.Router();
const PaymentController = require('../controllers/payment.controller');
const auth = require('../middlewares/auth.middleware');
const validate = require('../middlewares/validate.middleware');
const { createCheckoutSessionRules } = require('../validators/payment.validator');

router.post(
  '/create-checkout-session',
  auth,
  createCheckoutSessionRules,
  validate,
  PaymentController.createCheckoutSession
);

// Reconciliation fallback — see payment.service.js#reconcileSession.
router.get('/session/:sessionId', auth, PaymentController.getCheckoutSession);

module.exports = router;
