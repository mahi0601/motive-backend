// src/services/notification.service.js
const Notification = require('../models/notification.model');

exports.create = (data) => Notification.create(data);
exports.findByUser = (userId) => Notification.find({ userId }).sort({ createdAt: -1 });
exports.markAsRead = (id) => Notification.findByIdAndUpdate(id, { read: true });
exports.clearAll = (userId) => Notification.deleteMany({ userId });
