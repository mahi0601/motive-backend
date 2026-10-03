const { body } = require('express-validator');

// Mirrors the Prisma enums (schema.prisma) — a bad value used to reach Prisma
// and come back as an unhandled 500.
const PRIORITIES = ['Low', 'Medium', 'High'];
const STATUSES = ['todo', 'in_progress', 'done'];
const RECURRENCES = ['daily', 'weekly', 'monthly'];

// Every field is optional on update; `title` is additionally required on
// create. Unknown fields are ignored here — the service allowlists what it
// actually writes.
const fields = [
  body('description').optional({ nullable: true }).isString().isLength({ max: 10000 }).withMessage('Description is too long'),
  body('priority').optional().isIn(PRIORITIES).withMessage(`Priority must be one of: ${PRIORITIES.join(', ')}`),
  body('status').optional().isIn(STATUSES).withMessage(`Status must be one of: ${STATUSES.join(', ')}`),
  body('category').optional().isString().isLength({ min: 1, max: 100 }).withMessage('Category must be 1–100 characters'),
  // date-only ("2026-09-15", from <input type="date">) and full ISO datetimes are both accepted.
  // '' means "clear the date" (the service already treats it as null), so it's
  // normalized rather than rejected.
  body('dueDate')
    .customSanitizer((v) => (v === '' ? null : v))
    .optional({ nullable: true })
    .isISO8601()
    .withMessage('dueDate must be an ISO 8601 date'),
  body('tags').optional().isArray({ max: 50 }).withMessage('Tags must be a list of at most 50'),
  body('tags.*').isString().isLength({ max: 50 }).withMessage('Each tag must be at most 50 characters'),
  // The task form sends '' for "no recurrence"; normalize it to null.
  body('recurrence')
    .customSanitizer((v) => (v === '' ? null : v))
    .optional({ nullable: true })
    .isIn(RECURRENCES)
    .withMessage(`Recurrence must be one of: ${RECURRENCES.join(', ')}`),
  body('position').optional({ nullable: true }).isInt({ min: 0 }).withMessage('Position must be a non-negative integer'),
  body('assigneeId').optional({ nullable: true }).isString().isLength({ max: 64 }),
  body('workspaceId').optional({ nullable: true }).isString().isLength({ max: 64 }),
];

exports.createTaskRules = [
  body('title').isString().trim().isLength({ min: 1, max: 500 }).withMessage('Title is required (max 500 characters)'),
  ...fields,
];

exports.updateTaskRules = [
  body('title').optional().isString().trim().isLength({ min: 1, max: 500 }).withMessage('Title must be 1–500 characters'),
  ...fields,
];

// Bulk import: the frontend parses a CSV and sends the rows. All or nothing, so every
// row is checked here and one bad row refuses the batch (the error path says which,
// e.g. tasks[2].title). Only these fields are read from a row; the service takes them
// by name, so anything else in a row (an id, an owner, a workspace) is ignored.
const MAX_IMPORT_ROWS = 500;
exports.MAX_IMPORT_ROWS = MAX_IMPORT_ROWS;

const blankToNull = (v) => (v === '' ? null : v);
exports.importTasksRules = [
  body('workspaceId').optional({ nullable: true }).isString().isLength({ max: 64 }),
  body('tasks').isArray({ min: 1, max: MAX_IMPORT_ROWS }).withMessage(`Send between 1 and ${MAX_IMPORT_ROWS} tasks`),
  body('tasks.*').isObject().withMessage('Each task must be an object'),
  body('tasks.*.title').isString().trim().isLength({ min: 1, max: 500 }).withMessage('Title is required (max 500 characters)'),
  body('tasks.*.description').optional({ nullable: true }).isString().isLength({ max: 10000 }).withMessage('Description is too long'),
  body('tasks.*.priority').optional({ nullable: true }).isIn(PRIORITIES).withMessage(`Priority must be one of: ${PRIORITIES.join(', ')}`),
  body('tasks.*.status').optional({ nullable: true }).isIn(STATUSES).withMessage(`Status must be one of: ${STATUSES.join(', ')}`),
  body('tasks.*.category').optional({ nullable: true }).isString().isLength({ min: 1, max: 100 }).withMessage('Category must be 1–100 characters'),
  body('tasks.*.dueDate').customSanitizer(blankToNull).optional({ nullable: true }).isISO8601().withMessage('dueDate must be an ISO 8601 date'),
  body('tasks.*.completedAt').customSanitizer(blankToNull).optional({ nullable: true }).isISO8601().withMessage('completedAt must be an ISO 8601 date'),
  body('tasks.*.tags').optional({ nullable: true }).isArray({ max: 50 }).withMessage('Tags must be a list of at most 50'),
  body('tasks.*.tags.*').isString().isLength({ max: 50 }).withMessage('Each tag must be at most 50 characters'),
];
