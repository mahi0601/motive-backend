// src/app.js
// Builds the Express app and nothing else — no listening, no sockets, no
// process-level handlers — so tests (supertest) can import it without binding
// a port. server.js is what actually boots it.
const express = require('express');
const pinoHttp = require('pino-http');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');

const config = require('./config/env');
const prisma = require('./config/prisma');
const routes = require('./routes/index');
const { enabled: sentryEnabled, Sentry } = require('./config/sentry');
const logger = require('./config/logger');
const errorHandler = require('./middlewares/error.middleware');
const paymentController = require('./controllers/payment.controller');
const { DOWNLOAD_ONLY_EXTENSIONS } = require('./utils/fileTypes');
const path = require('path');

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
//
// That ordering also puts it ahead of the global /api rate limiter below, so it
// gets its own. It is public (authenticated only by the signature, which costs
// an HMAC per request), so this just caps abuse: this app receives a handful of
// events a minute, far under the cap, and Stripe retries anything it gets a 429
// for, so a legitimate event is never lost.
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, try again later.' },
});
app.post('/api/payments/webhook', webhookLimiter, express.raw({ type: 'application/json' }), paymentController.webhook);

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
  express.static('public/uploads', {
    setHeaders: (res, filePath) => {
      // Matches the R2 branch's ContentDisposition (storage.service.js) —
      // a .pdf/.docx opens as a download instead of rendering inline.
      if (DOWNLOAD_ONLY_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
        res.setHeader('Content-Disposition', 'attachment');
      }
    },
  })
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

// Uploads are the one endpoint that writes arbitrary-size data to storage, so
// it gets its own tighter cap than the global 1000/15min — per IP, POST only.
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many uploads, try again later.' },
});
app.post('/api/uploads', uploadLimiter);

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
// Translate client-input errors (bad Prisma args, missing FK, …) into 4xx
// first, so Sentry — which reports anything that isn't a sub-500 error — only
// sees genuine server faults.
app.use(errorHandler.normalizeErrors);
// Must be registered after routes but before our own error handler, so
// Sentry sees the error first while it's still unhandled.
if (sentryEnabled) Sentry.setupExpressErrorHandler(app);
app.use(errorHandler);

module.exports = app;
