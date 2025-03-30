let ioInstance;

const initSocket = (server) => {
  const { Server } = require('socket.io');
  ioInstance = new Server(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST']
    }
  });

  ioInstance.on('connection', (socket) => {
    console.log(`🔌 User connected: ${socket.id}`);

    // Emit updated tasks to all users
    socket.on('taskUpdated', (data) => {
      ioInstance.emit('refreshTasks', data); // Broadcast update to all
    });

    socket.on('disconnect', () => {
      console.log(`⚡ User disconnected: ${socket.id}`);
    });
  });

  return ioInstance;
};

module.exports = { initSocket, getIO: () => ioInstance };
