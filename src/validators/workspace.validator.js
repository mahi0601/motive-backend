const { body } = require('express-validator');

exports.inviteRules = [
  body('email').trim().isEmail().withMessage('A valid email is required').normalizeEmail(),
  body('role').optional().isIn(['editor', 'viewer']).withMessage('Role must be editor or viewer'),
];

exports.roleUpdateRules = [
  body('role').isIn(['editor', 'viewer']).withMessage('Role must be editor or viewer'),
];

// `name` and `icon` are the only fields the service writes; both optional
// (the schema has defaults), but bounded when present.
exports.createWorkspaceRules = [
  body('name').optional().isString().trim().isLength({ min: 1, max: 100 }).withMessage('Workspace name must be 1–100 characters'),
  body('icon').optional().isString().isLength({ max: 32 }),
];
