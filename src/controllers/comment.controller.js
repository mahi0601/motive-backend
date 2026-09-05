// src/controllers/comment.controller.js
const prisma = require('../config/prisma');

exports.addComment = async (req, res, next) => {
  try {
    const { taskId, text } = req.body;
    const comment = await prisma.comment.create({
      data: { taskId, userId: req.user.id, text },
      include: { user: { select: { name: true } } },
    });

    // Notify the task owner someone commented (skip self-comments).
    const task = await prisma.task.findUnique({ where: { id: taskId }, select: { userId: true, title: true } });
    if (task && task.userId !== req.user.id) {
      await prisma.notification.create({
        data: {
          userId: task.userId,
          title: 'New comment',
          message: `${comment.user.name} commented on "${task.title}"`,
          type: 'comment',
        },
      });
    }

    res.status(201).json({ success: true, comment });
  } catch (err) {
    next(err);
  }
};

exports.getCommentsByTaskId = async (req, res, next) => {
  try {
    const { taskId } = req.params;
    const comments = await prisma.comment.findMany({
      where: { taskId },
      include: { user: { select: { name: true, email: true } } },
    });
    res.status(200).json({ success: true, comments });
  } catch (err) {
    next(err);
  }
};
