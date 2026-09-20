const { body } = require('express-validator');

exports.inviteRules = [
  body('email').trim().isEmail().withMessage('A valid email is required').normalizeEmail(),
  body('role').optional().isIn(['editor', 'viewer']).withMessage('Role must be editor or viewer'),
];

exports.roleUpdateRules = [
  body('role').isIn(['editor', 'viewer']).withMessage('Role must be editor or viewer'),
];
