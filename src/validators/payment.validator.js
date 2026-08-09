const { body } = require('express-validator');

exports.createCheckoutSessionRules = [
  body('currency').optional().isIn(['usd', 'inr']).withMessage('Unsupported currency'),
];
