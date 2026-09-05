// src/controllers/notification.controller.js
const prisma = require('../config/prisma');

exports.getUserNotifications = async (req, res, next) => {
  try {
    const notifications = await prisma.notification.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
    });
    res.status(200).json({ success: true, notifications });
  } catch (err) {
    next(err);
  }
};

exports.markAsRead = async (req, res, next) => {
  try {
    const { id } = req.params;
    // Scoped by userId too — otherwise any authenticated user could mark
    // another user's notification as read (IDOR).
    const { count } = await prisma.notification.updateMany({
      where: { id, userId: req.user.id },
      data: { read: true },
    });
    if (!count) return res.status(404).json({ success: false, message: 'Notification not found' });
    res.status(200).json({ success: true, message: 'Marked as read' });
  } catch (err) {
    next(err);
  }
};

exports.clearNotifications = async (req, res, next) => {
  try {
    await prisma.notification.deleteMany({ where: { userId: req.user.id } });
    res.status(200).json({ success: true, message: 'Notifications cleared' });
  } catch (err) {
    next(err);
  }
};
