// src/app.js
// Builds the Express app and nothing else — no listening, no sockets, no
// process-level handlers — so tests (supertest) can import it without binding
// a port. server.js is what actually boots it.
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');

const config = require('./config/env');
const prisma = require('./config/prisma');
const routes = require('./routes/index');
const { enabled: sentryEnabled, Sentry } = require('./config/sentry');
const logger = require('./config/logger');
const requestContext = require('./utils/requestContext');
const errorHandler = require('./middlewares/error.middleware');
const paymentController = require('./controllers/payment.controller');
const { DOWNLOAD_ONLY_EXTENSIONS } = require('./utils/fileTypes');
const path = require('path');

const app = express();

// Behind a load balancer / reverse proxy in production: trust X-Forwarded-* so
// rate-limiting and req.ip work correctly.
if (config.isProd) app.set('trust proxy', 1);

// Query strings: the simple parser makes every value a plain string (or an array
// when a name repeats). The default parser also turns ?a[b]=c into nested OBJECTS,
// which would then flow into database filters. Handlers can rely on plain strings.
app.set('query parser', 'simple');

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
app.use(logger.createHttpLogger());
app.use(requestContext.middleware);

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

// A repeated query parameter (?x=1&x=2) would arrive as an array, a shape no
// handler expects. Refuse it outright instead of letting each one trip over it.
app.use('/api', (req, res, next) => {
  const repeated = Object.keys(req.query).find((k) => Array.isArray(req.query[k]));
  if (repeated) return res.status(400).json({ success: false, message: 'Repeated query parameters are not allowed.' });
  next();
});

// ── Rate limiting ───────────────────────────────────────
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, max: 1000, standardHeaders: true, legacyHeaders: false }));

// Strict brute-force limit on credential endpoints only (not /refresh, which
// the client calls routinely on reload / token expiry).
// CREDENTIAL_RATE_MAX can raise it (a browser test suite signs in about that many
// times from one address). Only a positive number counts: zero, negative or text
// keeps 20, so a bad value cannot switch the protection off.
const credentialMax = Number.parseInt(process.env.CREDENTIAL_RATE_MAX, 10);
const credentialLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: credentialMax > 0 ? credentialMax : 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many attempts, try again later.' },
});
// One account is guessable from many addresses (a botnet, rotating proxies), which
// the per-ip limit above cannot see. This one is keyed on the email being tried,
// normalised, so ten wrong guesses at an account lock it for the window no matter
// where they come from. The key is a hash: the address is never kept in memory
// as a plain string key, and the 429 says nothing about whether the account exists.
const accountLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `login:${crypto.createHash('sha256').update(String(req.body?.email || '').trim().toLowerCase()).digest('hex')}`,
  skip: (req) => !req.body?.email, // validation rejects these anyway
  validate: { keyGeneratorIpFallback: false },
  message: { success: false, message: 'Too many attempts, try again later.' },
});
app.use('/api/auth/login', accountLoginLimiter);
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
app.get('/', (_req, res) => res.send('🚀 Clientglass API is up & running'));

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
