const { verifyToken } = require('../utils/jwt.util');
const config = require('../config/env');
const logger = require('../config/logger');
const blockService = require('../services/block.service');

let ioInstance;

// Handshake auth — every socket must present a valid access token to
// connect at all. Previously auth was per-event and optional: `page:join`
// still joined the room on an invalid/missing token (the catch below only
// logged, it didn't stop the join), so any client that knew or guessed a
// pageId received that page's full live content — block:created/updated/
// reordered — with no membership check whatsoever. Identity is now
// established once here, before any event handler runs, and every handler
// below trusts `socket.data.userId` instead of re-verifying a
// client-supplied token per event.
//
// Exported (rather than only registered via `io.use()` below) so it can be
// unit-tested against a plain `{ handshake, data }` stub without spinning
// up a real socket.io server/client pair.
function handshakeAuth(socket, next) {
  try {
    const payload = verifyToken(socket.handshake.auth?.token);
    if (payload.type !== 'access') throw new Error('not an access token');
    socket.data.userId = payload.id;
    next();
  } catch (err) {
    logger.warn('Socket handshake rejected — invalid or missing token', { err: err.message });
    next(new Error('unauthorized'));
  }
}

// ── Page co-editing rooms ──────────────────────────────
// Clients join a room per page to receive live block updates, presence, and
// cursor positions. Gated by the same assertPageAccess check block
// mutations already go through — a non-member gets no room, no presence
// broadcast, and no block:* events for that page, same as a non-member gets
// a 404 from the REST endpoints.
//
// Exported for the same reason as handshakeAuth above — testable against a
// stub socket (`{ data, join, to }`) plus real fixtures, no live connection
// needed.
async function handlePageJoin(socket, { pageId, name } = {}) {
  if (!pageId) return;
  try {
    await blockService.assertPageAccess(pageId, socket.data.userId, 'read');
  } catch (err) {
    logger.warn('page:join denied — no access to page', {
      pageId,
      userId: socket.data.userId,
      err: err.message,
    });
    return;
  }
  socket.join(`page:${pageId}`);
  socket.data.pageId = pageId;
  socket.data.user = { id: socket.data.userId, name: name || 'Someone' };
  socket.to(`page:${pageId}`).emit('presence:join', { socketId: socket.id, user: socket.data.user });
}

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

  ioInstance.use(handshakeAuth);

  ioInstance.on('connection', (socket) => {
    // debug, not info — this was unconditional console.log on every single
    // connection, the highest-volume log line this app produces. Still
    // available with LOG_LEVEL=debug for troubleshooting, but doesn't burn
    // through Logtail's metered free-tier ingestion by default.
    logger.debug('User connected', { socketId: socket.id, userId: socket.data.userId });

    // Per-user notification room — the handshake above already proved who
    // this socket is, so there's no separate `identify` round-trip to wait
    // on (and no window where a socket is connected but not yet in its own
    // room). Lets the server push a notification straight to every
    // tab/device a user has open, regardless of what page they're on.
    socket.join(`user:${socket.data.userId}`);

    socket.on('page:join', (payload) => handlePageJoin(socket, payload));

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

module.exports = {
  initSocket,
  getIO: () => ioInstance,
  emitNotification,
  // Exported for unit tests — see the comments above each function.
  handshakeAuth,
  handlePageJoin,
};
