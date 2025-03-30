// src/sockets/notification.socket.js
const Notification = require('../models/notification.model');

const notificationSocketHandler = (io) => {
  io.on('connection', (socket) => {
    console.log('🔔 Client connected for notifications:', socket.id);

    socket.on('subscribeToNotifications', (userId) => {
      socket.join(userId);
    });

    socket.on('disconnect', () => {
      console.log('🔌 Client disconnected:', socket.id);
    });
  });
};

const emitNotification = (io, userId, message) => {
  io.to(userId.toString()).emit('new-notification', message);
};

module.exports = {
  notificationSocketHandler,
  emitNotification,
};
