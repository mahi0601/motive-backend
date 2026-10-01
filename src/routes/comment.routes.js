// src/routes/comment.routes.js
const express = require('express');
const router = express.Router();
const CommentController = require('../controllers/comment.controller');
const auth = require('../middlewares/auth.middleware');
const validate = require('../middlewares/validate.middleware');
const { addCommentRules } = require('../validators/comment.validator');

router.post('/', auth, addCommentRules, validate, CommentController.addComment);
router.get('/:taskId', auth, CommentController.getCommentsByTaskId);

module.exports = router;
