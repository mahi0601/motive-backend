const { body } = require('express-validator');

exports.createSubtaskRules = [
  body('taskId').isString().isLength({ min: 1, max: 64 }).withMessage('taskId is required'),
  body('title').isString().trim().isLength({ min: 1, max: 500 }).withMessage('Title is required (max 500 characters)'),
];

exports.updateSubtaskRules = [
  body('title').optional().isString().trim().isLength({ min: 1, max: 500 }).withMessage('Title must be 1–500 characters'),
  body('done').optional().isBoolean().withMessage('done must be true or false'),
];
