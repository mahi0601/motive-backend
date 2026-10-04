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

const { ACCENTS } = require('../utils/statusAccents');

// Everything here is shown publicly to anyone with the status link, so it is
// plain text with hard length limits. An empty string (or null for the date)
// clears a field. Unknown keys are ignored by the service, which copies fields
// by name.
const optionalText = (field, max) =>
  body(field)
    .optional({ nullable: true })
    .isString()
    .withMessage(`${field} must be text`)
    .bail()
    .trim()
    .isLength({ max })
    .withMessage(`${field} must be at most ${max} characters`);

exports.statusPageRules = [
  optionalText('headline', 120),
  optionalText('summary', 600),
  optionalText('milestoneTitle', 100), // the first milestone; see updateStatusPage
  body('milestoneDate')
    .optional({ nullable: true })
    .custom((v) => v === '' || (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(Date.parse(v))))
    .withMessage('milestoneDate must be a date (YYYY-MM-DD)'),
  body('accent').optional().isIn(ACCENTS).withMessage(`accent must be one of: ${ACCENTS.join(', ')}`),
  body('hideBranding').optional().isBoolean({ strict: true }).withMessage('hideBranding must be true or false'),
  body('allowFeedback').optional().isBoolean({ strict: true }).withMessage('allowFeedback must be true or false'),
  body('notifyViews').optional().isBoolean({ strict: true }).withMessage('notifyViews must be true or false'),
];

// The whole ordered list of milestones. Plain text, bounded; an item with an id
// keeps its row. Which ids are acceptable is checked against the workspace by the
// service, not here.
exports.milestonesRules = [
  body('milestones').isArray({ max: 12 }).withMessage('milestones must be a list of up to 12'),
  body('milestones.*').isObject().withMessage('each milestone must be an object'),
  body('milestones.*.id').optional({ nullable: true }).isString().withMessage('a milestone id must be text'),
  body('milestones.*.title')
    .isString()
    .withMessage('each milestone needs a title')
    .bail()
    .trim()
    .isLength({ min: 1, max: 100 })
    .withMessage('a milestone title must be 1–100 characters'),
  body('milestones.*.date')
    .optional({ nullable: true })
    .custom((v) => v === '' || (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(Date.parse(v))))
    .withMessage('a milestone date must be a date (YYYY-MM-DD)'),
];

// Copy a workspace's structure into a new one. `include` says what to copy (each flag a
// real boolean, all on when omitted); `startDate` is where the earliest date lands.
const INCLUDE_FLAGS = ['tasks', 'pages', 'milestones', 'statusText'];
exports.duplicateWorkspaceRules = [
  body('name').isString().withMessage('A name is required').bail().trim().isLength({ min: 1, max: 100 }).withMessage('The name must be 1–100 characters'),
  body('startDate')
    .optional({ nullable: true })
    .custom((v) => v === '' || (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(Date.parse(v))))
    .withMessage('startDate must be a date (YYYY-MM-DD)'),
  body('include').optional({ nullable: true }).isObject().withMessage('include must be an object'),
  ...INCLUDE_FLAGS.map((f) => body(`include.${f}`).optional().isBoolean({ strict: true }).withMessage(`include.${f} must be true or false`)),
];
