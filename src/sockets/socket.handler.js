const { verifyToken } = require('../utils/jwt.util');
const config = require('../config/env');
const logger = require('../config/logger');

let ioInstance;

const initSocket = (server) => {
  const { Server } = require('socket.io');
  ioInstance = new Server(server, {
    cors: {
      // Shares the exact same allowlist check as the HTTP CORS middleware
      // (config.corsOriginCheck, in config/env.js) — previously each
      // hand-rolled its own copy of this closure.
      origin: config.corsOriginCheck,
      methods: ['GET', 'POST']
    }
  });

  ioInstance.on('connection', (socket) => {
    // debug, not info — this was unconditional console.log on every single
    // connection, the highest-volume log line this app produces. Still
    // available with LOG_LEVEL=debug for troubleshooting, but doesn't burn
    // through Logtail's metered free-tier ingestion by default.
    logger.debug('User connected', { socketId: socket.id });

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
      } catch (err) {
        // Was fully silent — an invalid/expired token here has zero trace
        // today. Still lets them join as an anonymous viewer (unchanged
        // behavior), just no longer invisible.
        logger.warn('page:join with an invalid token — joining as anonymous', { pageId, err: err.message });
      }
      socket.join(`page:${pageId}`);
      socket.data.pageId = pageId;
      socket.data.user = { id: userId, name: name || 'Someone' };
      socket.to(`page:${pageId}`).emit('presence:join', { socketId: socket.id, user: socket.data.user });
    });

    // ── Per-user notification room ─────────────────────
    // Separate from page:join's room (which is per-page, for co-editing
    // presence) — this lets the server push a notification straight to
    // every tab/device a user has open, regardless of what page they're on.
    // JWT-verified the same way page:join is, so a socket can't claim to be
    // a different user's notification target.
    socket.on('identify', ({ token } = {}) => {
      try {
        const payload = verifyToken(token);
        if (payload.type === 'access') {
          socket.data.userId = payload.id;
          socket.join(`user:${payload.id}`);
        }
      } catch (err) {
        // Was fully silent. Behavior unchanged (socket just won't receive
        // notification pushes) — just no longer invisible.
        logger.warn('identify with an invalid token — no notification room joined', { err: err.message });
      }
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
      logger.debug('User disconnected', { socketId: socket.id });
    });
  });

  return ioInstance;
};

// Push a notification to every socket a user currently has open. Safe to
// call before initSocket runs (e.g. in tests) — just a no-op then.
const emitNotification = (userId, notification) => {
  if (ioInstance) ioInstance.to(`user:${userId}`).emit('notification:new', notification);
};

module.exports = { initSocket, getIO: () => ioInstance, emitNotification };
