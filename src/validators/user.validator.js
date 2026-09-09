const { body } = require('express-validator');

exports.deleteAccountRules = [
  body('password').notEmpty().withMessage('Password is required to delete your account'),
];
