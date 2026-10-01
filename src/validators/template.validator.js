const { body } = require('express-validator');

exports.saveTemplateRules = [
  body('pageId').isString().isLength({ min: 1, max: 64 }).withMessage('pageId is required'),
  body('name').optional({ nullable: true }).isString().isLength({ max: 100 }).withMessage('Name must be at most 100 characters'),
  body('icon').optional({ nullable: true }).isString().isLength({ max: 32 }),
  body('description').optional({ nullable: true }).isString().isLength({ max: 500 }),
];

exports.useTemplateRules = [
  body('parentId').optional({ nullable: true }).isString().isLength({ max: 64 }),
  body('workspaceId').optional({ nullable: true }).isString().isLength({ max: 64 }),
];
