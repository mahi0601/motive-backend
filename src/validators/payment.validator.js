const { body } = require('express-validator');

exports.createCheckoutSessionRules = [
  body('currency').optional().isIn(['usd', 'inr']).withMessage('Unsupported currency'),
  body('plan').optional().isIn(['studio', 'agency']).withMessage('Unsupported plan'),
  // Which gateway the buyer picked (checked against what is available for the currency by the
  // service) and, for gateways that need it, a phone number. Plain strings only, bounded; the
  // phone is validated by the gateway's own rules and is never stored.
  body('provider').optional().isString().isLength({ max: 20 }).withMessage('Unsupported payment method'),
  body('phone').optional().isString().isLength({ max: 20 }).withMessage('Enter a valid phone number'),
];

// Only the Studio -> Agency upgrade is offered, so that is the only plan accepted.
exports.changePlanRules = [
  body('plan').isIn(['agency']).withMessage('Unsupported plan'),
];
