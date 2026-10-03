const { body } = require('express-validator');

exports.createCheckoutSessionRules = [
  body('currency').optional().isIn(['usd', 'inr']).withMessage('Unsupported currency'),
  body('plan').optional().isIn(['studio', 'agency']).withMessage('Unsupported plan'),
];
