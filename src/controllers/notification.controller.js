// src/controllers/notification.controller.js
const NotificationService = require('../services/notification.service');
const asyncHandler = require('../utils/asyncHandler');

exports.getUserNotifications = asyncHandler(async (req, res) => {
  const result = await NotificationService.listForUser(req.user.id, req.query);
  res.status(200).json({ success: true, ...result });
});

exports.markAsRead = asyncHandler(async (req, res) => {
  await NotificationService.markAsRead(req.params.id, req.user.id);
  res.status(200).json({ success: true, message: 'Marked as read' });
});

exports.clearNotifications = asyncHandler(async (req, res) => {
  await NotificationService.clearAll(req.user.id);
  res.status(200).json({ success: true, message: 'Notifications cleared' });
});
