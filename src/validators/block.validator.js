const { body } = require('express-validator');

// Mirrors the BlockType enum in schema.prisma.
const BLOCK_TYPES = [
  'paragraph', 'heading1', 'heading2', 'heading3', 'bulleted', 'numbered',
  'todo', 'toggle', 'quote', 'code', 'divider', 'image', 'callout', 'table', 'embed',
];
const MAX_CONTENT_BYTES = 100 * 1024;

// Block content is free-form JSON, so the two things worth enforcing are that
// it IS an object (not a string/array that later code would choke on) and that
// it isn't unbounded — the global body limit is 5 MB.
const contentRule = body('content')
  .optional()
  .custom((value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Block content must be an object');
    }
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_CONTENT_BYTES) {
      throw new Error('Block content is too large (max 100 KB)');
    }
    return true;
  });

const common = [
  body('type').optional().isIn(BLOCK_TYPES).withMessage(`Block type must be one of: ${BLOCK_TYPES.join(', ')}`),
  contentRule,
  body('position').optional({ nullable: true }).isInt({ min: 0 }).withMessage('Position must be a non-negative integer'),
  body('parentBlockId').optional({ nullable: true }).isString().isLength({ max: 64 }),
];

exports.createBlockRules = common;
exports.updateBlockRules = common;

exports.reorderBlocksRules = [
  body('order').isArray({ max: 1000 }).withMessage('order must be a list of at most 1000 items'),
  body('order.*.id').isString().isLength({ min: 1, max: 64 }).withMessage('Each item needs an id'),
  body('order.*.position').isInt({ min: 0 }).withMessage('Each item needs a non-negative integer position'),
];
