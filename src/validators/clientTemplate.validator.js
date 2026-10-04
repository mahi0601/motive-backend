const { body } = require('express-validator');

const name = body('name').isString().withMessage('A name is required').bail().trim().isLength({ min: 1, max: 100 }).withMessage('The name must be 1–100 characters');
const INCLUDE_FLAGS = ['tasks', 'pages', 'milestones', 'statusText'];

exports.saveTemplateRules = [
  body('workspaceId').isString().withMessage('workspaceId is required').bail().isLength({ min: 1, max: 100 }),
  name,
  body('description').optional({ nullable: true }).isString().withMessage('The description must be text').bail().trim().isLength({ max: 300 }).withMessage('The description can be up to 300 characters'),
];

// Same shape as duplicating a client: `startDate` is where the earliest date lands.
exports.useTemplateRules = [
  name,
  body('startDate')
    .optional({ nullable: true })
    .custom((v) => v === '' || (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(Date.parse(v))))
    .withMessage('startDate must be a date (YYYY-MM-DD)'),
  body('include').optional({ nullable: true }).isObject().withMessage('include must be an object'),
  ...INCLUDE_FLAGS.map((f) => body(`include.${f}`).optional().isBoolean({ strict: true }).withMessage(`include.${f} must be true or false`)),
];
