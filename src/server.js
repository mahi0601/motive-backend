// src/server.js
const http = require('http');
const express = require('express');
const pinoHttp = require('pino-http');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');

const config = require('./config/env');
const connectDB = require('./config/db');
const prisma = require('./config/prisma');
const routes = require('./routes/index');
const { enabled: sentryEnabled, Sentry } = require('./config/sentry');
const logger = require('./config/logger');
const errorHandler = require('./middlewares/error.middleware');
const { initSocket } = require('./sockets/socket.handler');
const paymentController = require('./controllers/payment.controller');

const app = express();

// Behind a load balancer / reverse proxy in production: trust X-Forwarded-* so
// rate-limiting and req.ip work correctly.
if (config.isProd) app.set('trust proxy', 1);

// ── Security & parsing middleware ───────────────────────
app.use(helmet());
app.use(
  cors({
    origin: config.corsOriginCheck,
    credentials: true,
  })
);
// Stripe webhook needs the raw request body to verify the signature — must be
// registered BEFORE express.json() so it isn't parsed/re-serialized first.
app.post('/api/payments/webhook', express.raw({ type: 'application/json' }), paymentController.webhook);

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
// Replaces morgan — structured, request-id-correlated JSON logs through the
// same centralized logger everything else now uses, instead of a second,
// unrelated plain-text log format. Mounted after the raw-body Stripe
// webhook route above, same as morgan was, so that request's body is never
// logged either.
app.use(pinoHttp({ logger: logger.pino }));

// Serve uploaded attachments. The frontend and API are on different origins
// (even in prod: motive-app-*.onrender.com vs motive-api-*.onrender.com), and
// helmet()'s default Cross-Origin-Resource-Policy: same-origin would block an
// <img>/download from a different origin from ever loading these — relaxed
// just for this path, since uploaded files are meant to be fetchable by the
// app that uploaded them.
app.use(
  '/uploads',
  (req, res, next) => {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    next();
  },
  express.static('public/uploads')
);

// ── Rate limiting ───────────────────────────────────────
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, max: 1000, standardHeaders: true, legacyHeaders: false }));

// Strict brute-force limit on credential endpoints only (not /refresh, which
// the client calls routinely on reload / token expiry).
const credentialLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many attempts, try again later.' },
});
app.use('/api/auth/login', credentialLimiter);
app.use('/api/auth/register', credentialLimiter);
app.use('/api/auth/forgot-password', credentialLimiter);
app.use('/api/auth/reset-password', credentialLimiter);
app.use('/api/auth/native-exchange', credentialLimiter);

// ── Health & readiness ──────────────────────────────────
app.get('/api/health', async (_req, res) => {
  let dbUp = true;
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    dbUp = false;
  }
  res.status(dbUp ? 200 : 503).json({
    status: dbUp ? 'ok' : 'degraded',
    db: dbUp ? 'connected' : 'disconnected',
    uptime: process.uptime(),
  });
});
app.get('/', (_req, res) => res.send('🚀 Motive API is up & running'));

// ── Routes & error handler ──────────────────────────────
app.use('/api', routes);
// Must be registered after routes but before our own error handler, so
// Sentry sees the error first while it's still unhandled.
if (sentryEnabled) Sentry.setupExpressErrorHandler(app);
app.use(errorHandler);

// ── Boot ────────────────────────────────────────────────
const server = http.createServer(app);
initSocket(server);

connectDB()
  .then(() => {
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
