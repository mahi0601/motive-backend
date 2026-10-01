// Revocation for already-open sockets. A socket is authenticated once, at
// connect, so anything that ends or reduces a user's access has to reach into
// their live connections explicitly. Kept apart from socket.handler.js and
// required lazily by callers, because socket.handler pulls in the services that
// need to call this (a require cycle otherwise).
const logger = require('../config/logger');

const getIO = () => require('./socket.handler').getIO();

// Drop every connection a user has — logout-everywhere, account deletion, a
// password/credential change. The client must sign in again to reconnect.
exports.disconnectUser = (userId) => {
  const io = getIO();
  if (!io || !userId) return;
  io.in(`user:${userId}`).disconnectSockets(true);
};

// After a membership change: re-check the page each of the user's sockets is
// currently in, and pull them out of any they can no longer read. Other pages,
// notifications and the connection itself are left alone.
exports.recheckUserAccess = async (userId) => {
  const io = getIO();
  if (!io || !userId) return;
  const blockService = require('../services/block.service');
  const sockets = await io.in(`user:${userId}`).fetchSockets();
  await Promise.all(
    sockets.map(async (socket) => {
      const pageId = socket.data.pageId;
      if (!pageId) return;
      try {
        await blockService.assertPageAccess(pageId, userId, 'read');
      } catch {
        socket.leave(`page:${pageId}`);
        socket.data.pageId = undefined;
        io.to(`page:${pageId}`).emit('presence:leave', { socketId: socket.id });
        socket.emit('access:revoked', { pageId });
      }
    })
  ).catch((err) => logger.warn('socket access recheck failed', { err: err?.message }));
};
