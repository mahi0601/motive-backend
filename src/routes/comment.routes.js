// src/routes/comment.routes.js
const express = require('express');
const router = express.Router();
const CommentController = require('../controllers/comment.controller');
const auth = require('../middlewares/auth.middleware');

router.post('/', auth, CommentController.addComment);
router.get('/:taskId', auth, CommentController.getCommentsByTaskId);

module.exports = router;
