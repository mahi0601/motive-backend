const { verifyToken } = require('../utils/jwt.util');

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
    // Clients join a room per page to receive live block updates, presence,
    // and cursor positions. `token` is the same JWT access token used for
    // REST calls — verified here so the socket's userId is authoritative
    // (previously this trusted a client-supplied `user` object outright,
    // meaning any socket could claim to be anyone). `name`/`avatar` stay
    // client-supplied since they're cosmetic display data, not an identity.
    socket.on('page:join', ({ pageId, token, name } = {}) => {
      if (!pageId) return;
      let userId = null;
      try {
        const payload = verifyToken(token);
        if (payload.type === 'access') userId = payload.id;
      } catch {
        /* no valid token — still let them join as an anonymous viewer */
      }
      socket.join(`page:${pageId}`);
      socket.data.pageId = pageId;
      socket.data.user = { id: userId, name: name || 'Someone' };
      socket.to(`page:${pageId}`).emit('presence:join', { socketId: socket.id, user: socket.data.user });
    });

    socket.on('page:leave', ({ pageId } = {}) => {
      if (!pageId) return;
      socket.leave(`page:${pageId}`);
      socket.to(`page:${pageId}`).emit('presence:leave', { socketId: socket.id });
    });

    // { x, y } as a fraction (0-1) of the page content area — resolution-
    // independent so it renders sensibly regardless of viewport size.
    socket.on('cursor:move', ({ x, y } = {}) => {
      const pageId = socket.data.pageId;
      if (!pageId || typeof x !== 'number' || typeof y !== 'number') return;
      socket.to(`page:${pageId}`).emit('cursor:move', { socketId: socket.id, user: socket.data.user, x, y });
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
