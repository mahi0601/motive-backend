// src/controllers/notification.controller.js
const Notification = require('../models/notification.model');

exports.getUserNotifications = async (req, res, next) => {
  try {
    const notifications = await Notification.find({ userId: req.user.id }).sort({ createdAt: -1 });
    res.status(200).json({ success: true, notifications });
  } catch (err) {
    next(err);
  }
};

exports.markAsRead = async (req, res, next) => {
  try {
    const { id } = req.params;
    await Notification.findByIdAndUpdate(id, { read: true });
    res.status(200).json({ success: true, message: "Marked as read" });
  } catch (err) {
    next(err);
  }
};

exports.clearNotifications = async (req, res, next) => {
  try {
    await Notification.deleteMany({ userId: req.user.id });
    res.status(200).json({ success: true, message: "Notifications cleared" });
  } catch (err) {
    next(err);
  }
};
