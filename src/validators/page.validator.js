const { body } = require('express-validator');

const id = (name) => body(name).optional({ nullable: true }).isString().isLength({ max: 64 });

exports.createPageRules = [
  body('title').optional().isString().isLength({ max: 200 }).withMessage('Title must be at most 200 characters'),
  body('icon').optional({ nullable: true }).isString().isLength({ max: 32 }),
  id('parentId'),
  id('workspaceId'),
];

exports.updatePageRules = [
  body('title').optional().isString().isLength({ max: 200 }).withMessage('Title must be at most 200 characters'),
  body('icon').optional({ nullable: true }).isString().isLength({ max: 32 }),
  body('cover').optional({ nullable: true }).isString().isLength({ max: 2048 }),
  id('parentId'),
  body('position').optional().isInt({ min: 0 }).withMessage('Position must be a non-negative integer'),
  body('favorite').optional().isBoolean().withMessage('favorite must be true or false'),
  body('archived').optional().isBoolean().withMessage('archived must be true or false'),
];
