// src/controllers/comment.controller.js
const prisma = require('../config/prisma');

// Mentions are authored as @[Display Name](userId) — parsed back into a
// styled chip client-side. Extracts the distinct mentioned user ids.
const MENTION_RE = /@\[[^\]]+\]\(([^)]+)\)/g;
const extractMentionedUserIds = (text) => [...new Set([...text.matchAll(MENTION_RE)].map((m) => m[1]))];

exports.addComment = async (req, res, next) => {
  try {
    const { taskId, text } = req.body;
    const comment = await prisma.comment.create({
      data: { taskId, userId: req.user.id, text },
      include: { user: { select: { name: true } } },
    });

    const task = await prisma.task.findUnique({ where: { id: taskId }, select: { userId: true, title: true } });

    // Notify the task owner someone commented (skip self-comments).
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

    // Notify each @mentioned user (skip mentioning yourself, and skip a
    // duplicate notification for the task owner if they're mentioned too).
    const mentionedIds = extractMentionedUserIds(text).filter(
      (id) => id !== req.user.id && id !== task?.userId
    );
    if (mentionedIds.length) {
      await prisma.notification.createMany({
        data: mentionedIds.map((userId) => ({
          userId,
          title: 'You were mentioned',
          message: `${comment.user.name} mentioned you on "${task?.title ?? 'a task'}"`,
          type: 'mention',
        })),
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
