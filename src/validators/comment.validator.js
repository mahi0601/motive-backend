const { body } = require('express-validator');

exports.addCommentRules = [
  body('taskId').isString().isLength({ min: 1, max: 64 }).withMessage('taskId is required'),
  body('text').isString().trim().isLength({ min: 1, max: 5000 }).withMessage('Comment must be 1–5000 characters'),
];
