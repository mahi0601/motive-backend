// src/server.js
// Boots the app from app.js: HTTP server, Socket.io, DB connection, graceful
// shutdown. Kept separate from app.js so importing the app (tests) has no
// side effects.
const http = require('http');

const config = require('./config/env');
const connectDB = require('./config/db');
const prisma = require('./config/prisma');
const app = require('./app');
const logger = require('./config/logger');
const { initSocket } = require('./sockets/socket.handler');
const cleanupJob = require('./jobs/cleanup');
const statusDigestJob = require('./jobs/statusDigest');

// ── Boot ────────────────────────────────────────────────
const server = http.createServer(app);
initSocket(server);

connectDB()
  .then(() => {
    cleanupJob.start();
    statusDigestJob.start();
    server.listen(config.port, () => {
      logger.info(`Server running at http://localhost:${config.port}`, { env: config.env });
    });
  })
  .catch((err) => {
    logger.error('Failed to connect to the database', err);
    process.exit(1);
  });

// ── Graceful shutdown — drain connections before exit ───
const shutdown = (signal) => {
  logger.info('Shutting down gracefully', { signal });
  server.close(() => {
    prisma.$disconnect().then(() => {
      logger.info('Closed HTTP server and DB connection');
      process.exit(0);
    });
  });
  // Force-exit if cleanup hangs.
  setTimeout(() => process.exit(1), 10000).unref();
};
['SIGTERM', 'SIGINT'].forEach((sig) => process.on(sig, () => shutdown(sig)));

// Last-resort safety nets — log and exit so the orchestrator can restart cleanly.
// logger.error already calls Sentry.captureException for non-operational
// errors (see config/logger.js), so the manual Sentry calls this file used
// to make here are redundant with it and have been removed in favor of it.
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection', reason instanceof Error ? reason : new Error(String(reason)));
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception', err);
  process.exit(1);
});

module.exports = { app, server };
