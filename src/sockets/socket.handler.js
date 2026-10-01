const { verifyToken } = require('../utils/jwt.util');
const config = require('../config/env');
const logger = require('../config/logger');
const blockService = require('../services/block.service');
const sessionService = require('../services/session.service');

let ioInstance;

// ── Input hardening ────────────────────────────────────
// Every socket event is client-controlled input. socket.io invokes listeners
// from process.nextTick, so a synchronous throw inside one (the classic case:
// destructuring a `null` payload, which a `= {}` default does NOT cover)
// becomes an uncaughtException — and server.js answers those with
// process.exit(1). One malformed message from any logged-in user would restart
// the whole single-instance API and drop every other user's socket.
const MAX_NAME_LENGTH = 80;
const MIN_CURSOR_INTERVAL_MS = 33; // ~30 cursor updates a second per socket
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isId = (v) => typeof v === 'string' && v.length > 0 && v.length <= 64;
const pageRoom = (pageId) => `page:${pageId}`;

// Register `handler` so nothing a client sends can throw out of it: non-object
// payloads are ignored, and sync or async failures are caught and logged.
function safeOn(socket, event, handler) {
  socket.on(event, (payload) => {
    if (!isPlainObject(payload)) return;
    Promise.resolve()
      .then(() => handler(payload))
      .catch((err) => logger.warn(`socket "${event}" handler failed`, { err: err?.message }));
  });
}

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
async function handshakeAuth(socket, next) {
  try {
    const payload = verifyToken(socket.handshake.auth?.token);
    if (payload.type !== 'access') throw new Error('not an access token');
    // Must belong to a live session of the current version — a logged-out or
    // revoked session cannot open a new socket with an unexpired token.
    await sessionService.assertAccessPayload(payload);
    socket.data.userId = payload.id;
    socket.data.sid = payload.sid;
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
async function handlePageJoin(socket, payload) {
  if (!isPlainObject(payload) || !isId(payload.pageId)) return;
  const { pageId } = payload;
  // The presence name is shown to other members, so it must be a short string.
  const name = typeof payload.name === 'string' ? payload.name.trim().slice(0, MAX_NAME_LENGTH) : '';
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
  // One page at a time: joining another leaves the previous room, so rooms and
  // presence don't accumulate and cursor events can't leak into stale pages.
  const previous = socket.data.pageId;
  if (previous && previous !== pageId) {
    socket.leave(pageRoom(previous));
    socket.to(pageRoom(previous)).emit('presence:leave', { socketId: socket.id });
  }
  socket.join(pageRoom(pageId));
  socket.data.pageId = pageId;
  socket.data.user = { id: socket.data.userId, name: name || 'Someone' };
  socket.to(pageRoom(pageId)).emit('presence:join', { socketId: socket.id, user: socket.data.user });
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

    safeOn(socket, 'page:join', (payload) => handlePageJoin(socket, payload));

    // Only a socket that is actually IN the room may announce leaving it —
    // socket.to(room).emit() reaches a room whether or not the sender is in it,
    // so without this check anyone could broadcast a fake "left" for a page.
    safeOn(socket, 'page:leave', ({ pageId }) => {
      if (!isId(pageId) || !socket.rooms.has(pageRoom(pageId))) return;
      socket.leave(pageRoom(pageId));
      if (socket.data.pageId === pageId) socket.data.pageId = undefined;
      socket.to(pageRoom(pageId)).emit('presence:leave', { socketId: socket.id });
    });

    // { x, y } as a fraction (0-1) of the page content area — resolution-
    // independent so it renders sensibly regardless of viewport size.
    // Throttled per socket: it fans out to every member of the room, so an
    // unthrottled client could flood them all.
    let lastCursorAt = 0;
    safeOn(socket, 'cursor:move', ({ x, y }) => {
      const pageId = socket.data.pageId;
      if (!pageId || !socket.rooms.has(pageRoom(pageId))) return;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      const now = Date.now();
      if (now - lastCursorAt < MIN_CURSOR_INTERVAL_MS) return;
      lastCursorAt = now;
      socket.to(pageRoom(pageId)).emit('cursor:move', { socketId: socket.id, user: socket.data.user, x, y });
    });

    socket.on('disconnect', () => {
      if (socket.data.pageId) {
        socket.to(pageRoom(socket.data.pageId)).emit('presence:leave', { socketId: socket.id });
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
