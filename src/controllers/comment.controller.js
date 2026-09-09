// src/controllers/comment.controller.js
const CommentService = require('../services/comment.service');
const asyncHandler = require('../utils/asyncHandler');
const { emitNotification } = require('../sockets/socket.handler');

exports.addComment = asyncHandler(async (req, res) => {
  const { taskId, text } = req.body;
  const { comment, notifications } = await CommentService.addComment(taskId, req.user.id, text);
  notifications.forEach(({ userId, ...notification }) => emitNotification(userId, notification));
  res.status(201).json({ success: true, comment });
});

exports.getCommentsByTaskId = asyncHandler(async (req, res) => {
  const comments = await CommentService.getComments(req.params.taskId, req.user.id);
  res.status(200).json({ success: true, comments });
});
