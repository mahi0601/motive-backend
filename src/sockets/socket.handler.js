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

    // ── Page co-editing rooms ──────────────────────────
    // Clients join a room per page to receive live block updates + presence.
    socket.on('page:join', ({ pageId, user } = {}) => {
      if (!pageId) return;
      socket.join(`page:${pageId}`);
      socket.data.pageId = pageId;
      socket.data.user = user;
      socket.to(`page:${pageId}`).emit('presence:join', { socketId: socket.id, user });
    });

    socket.on('page:leave', ({ pageId } = {}) => {
      if (!pageId) return;
      socket.leave(`page:${pageId}`);
      socket.to(`page:${pageId}`).emit('presence:leave', { socketId: socket.id });
    });

    socket.on('disconnect', () => {
      if (socket.data.pageId) {
        socket.to(`page:${socket.data.pageId}`).emit('presence:leave', { socketId: socket.id });
      }
      console.log(`⚡ User disconnected: ${socket.id}`);
    });
  });

  return ioInstance;
};

module.exports = { initSocket, getIO: () => ioInstance };
