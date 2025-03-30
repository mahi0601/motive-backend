// src/controllers/comment.controller.js
const Comment = require('../models/comment.model');

exports.addComment = async (req, res, next) => {
  try {
    const { taskId, text } = req.body;
    const comment = await Comment.create({
      taskId,
      userId: req.user.id,
      text
    });
    res.status(201).json({ success: true, comment });
  } catch (err) {
    next(err);
  }
};

exports.getCommentsByTaskId = async (req, res, next) => {
  try {
    const { taskId } = req.params;
    const comments = await Comment.find({ taskId }).populate('userId', 'name email');
    res.status(200).json({ success: true, comments });
  } catch (err) {
    next(err);
  }
};
