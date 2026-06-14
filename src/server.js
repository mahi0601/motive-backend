// src/server.js
const http = require('http');
const express = require('express');
const mongoose = require('mongoose');
const morgan = require('morgan');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');

const config = require('./config/env');
const connectDB = require('./config/db');
const routes = require('./routes/index');
const errorHandler = require('./middlewares/error.middleware');
const { initSocket } = require('./sockets/socket.handler');

const app = express();

// Behind a load balancer / reverse proxy in production: trust X-Forwarded-* so
// rate-limiting and req.ip work correctly.
if (config.isProd) app.set('trust proxy', 1);

// ── Security & parsing middleware ───────────────────────
app.use(helmet());
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || config.corsOrigins.includes(origin)) return cb(null, true);
      return cb(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: true,
  })
);
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(morgan(config.isProd ? 'combined' : 'dev'));

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

// ── Health & readiness ──────────────────────────────────
app.get('/api/health', (_req, res) => {
  const dbUp = mongoose.connection.readyState === 1;
  res.status(dbUp ? 200 : 503).json({
    status: dbUp ? 'ok' : 'degraded',
    db: dbUp ? 'connected' : 'disconnected',
    uptime: process.uptime(),
  });
});
app.get('/', (_req, res) => res.send('🚀 Motive API is up & running'));

// ── Routes & error handler ──────────────────────────────
app.use('/api', routes);
app.use(errorHandler);

// ── Boot ────────────────────────────────────────────────
const server = http.createServer(app);
initSocket(server);

connectDB()
  .then(() => {
    server.listen(config.port, () => {
      console.log(`🚀 Server running at http://localhost:${config.port} [${config.env}]`);
    });
  })
  .catch((err) => {
    console.error('❌ Failed to connect to MongoDB:', err.message);
    process.exit(1);
  });

// ── Graceful shutdown — drain connections before exit ───
const shutdown = (signal) => {
  console.log(`\n${signal} received — shutting down gracefully…`);
  server.close(() => {
    mongoose.connection.close(false).then(() => {
      console.log('✅ Closed HTTP server and DB connection.');
      process.exit(0);
    });
  });
  // Force-exit if cleanup hangs.
  setTimeout(() => process.exit(1), 10000).unref();
};
['SIGTERM', 'SIGINT'].forEach((sig) => process.on(sig, () => shutdown(sig)));

// Last-resort safety nets — log and exit so the orchestrator can restart cleanly.
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  process.exit(1);
});

module.exports = { app, server };
