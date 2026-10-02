// Centralized logger — the single place an error gets both logged (stdout,
// structured JSON; optionally also Better Stack/Logtail) *and* reported to
// Sentry, so "console.log everywhere" and "Sentry only catches a few
// things" are fixed by the same piece of code, not two separate ones.
//
// Reads `process.env` directly rather than `require('./env')` — deliberate.
// config/env.js's own fatal validation (missing DATABASE_URL/JWT_SECRET)
// runs *before* the `config` object exists, so a logger that depended on it
// would be circular. Mirrors instrument.js's existing pattern of reading
// process.env.SENTRY_DSN directly for the same reason.
const pino = require('pino');
const pinoHttp = require('pino-http');
const { Sentry, enabled: sentryEnabled } = require('./sentry');

const isProd = process.env.NODE_ENV === 'production';
const logtailToken = process.env.LOGTAIL_SOURCE_TOKEN;

const pinoOptions = {
  level: process.env.LOG_LEVEL || (isProd ? 'info' : 'debug'),
  // Structured-field redaction — defense in depth for anything logged as an
  // object field (req.headers, a user record, etc.). This does NOT redact
  // values interpolated into a plain message *string* (e.g. a template
  // literal) — those call sites (see email.service.js) are fixed by not
  // interpolating the sensitive value into the message in the first place,
  // not by this config.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-csrf-token"]',
      'req.headers["stripe-signature"]',
      'res.headers["set-cookie"]',
      'res.headers.location',
      // `*.x` only matches one level down (user.x), NOT a top-level `x`, and
      // `*.*.x` two levels down, so each sensitive name is listed at all three depths.
      'password',
      '*.password',
      '*.*.password',
      'token',
      '*.token',
      '*.*.token',
      'accessToken',
      '*.accessToken',
      '*.*.accessToken',
      'refreshToken',
      '*.refreshToken',
      '*.*.refreshToken',
      'csrfToken',
      '*.csrfToken',
      '*.*.csrfToken',
      'email',
      '*.email',
      '*.*.email',
      'authorization',
      '*.authorization',
      '*.*.authorization',
      'cookie',
      '*.cookie',
      '*.*.cookie',
      'secret',
      '*.secret',
      '*.*.secret',
      'apiKey',
      '*.apiKey',
      '*.*.apiKey',
    ],
    censor: '[redacted]',
  },
};

// Dev: pretty-printed, human-readable, stdout only. Prod: plain structured
// JSON to stdout (Render's log dashboard reads this directly, no transport
// overhead) plus Logtail *only* if a source token is configured — same
// opt-in-and-no-op-gracefully pattern as every other integration in this
// app (Stripe, R2, Resend, Sentry).
let transport;
if (!isProd) {
  transport = pino.transport({ target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } });
} else if (logtailToken) {
  transport = pino.transport({
    targets: [
      { target: 'pino/file', options: { destination: 1 } }, // 1 = stdout
      { target: '@logtail/pino', options: { sourceToken: logtailToken, options: {} } },
    ],
  });
}

const base = transport ? pino(pinoOptions, transport) : pino(pinoOptions);

// ── HTTP request logging ───────────────────────────────
// pino-http's DEFAULT serializers log the full request URL and every request
// header, and the response headers — which include `Set-Cookie` (the 30-day
// refresh token) and `Location` (OAuth/CSRF hand-off). Logs end up on Render's
// dashboard and in Better Stack, readable by far more people than the
// database, so a token that appears there is a leaked credential.
//
// Some credentials live in the URL PATH rather than a header or body: the public
// status-page token, workspace invite tokens, and the Stripe checkout-session
// id. Query strings can carry ?code= / ?state= / ?csrf=. scrubUrl removes both.
const TOKEN_PATHS = [
  /^(\/api\/status\/)[^/?#]+/i,
  /^(\/api\/invites\/)[^/?#]+/i,
  /^(\/api\/payments\/session\/)[^/?#]+/i,
];

function scrubUrl(url) {
  if (!url) return '';
  const path = String(url).split('#')[0].split('?')[0]; // drop query string + fragment
  return TOKEN_PATHS.reduce((p, pattern) => p.replace(pattern, '$1[redacted]'), path);
}

// Logs only what operations need — method, scrubbed path, status, timing, and
// the client ip — and never headers. Uses `originalUrl` because Express strips
// the mount prefix from `req.url` while a request is inside a mounted router.
function createHttpLogger(instance = base) {
  return pinoHttp({
    logger: instance,
    serializers: {
      req: (req) => ({
        id: req.id,
        method: req.method,
        url: scrubUrl(req.originalUrl || req.url),
        ip: req.ip || req.socket?.remoteAddress,
      }),
      res: (res) => ({ statusCode: res.statusCode }),
    },
  });
}

// `err.isOperational` (see utils/AppError.js) is the same signal
// error.middleware.js already uses to decide what a client sees — reused
// here to decide what Sentry sees: an expected 4xx-shaped AppError (bad
// login, validation, "not found") is noise in Sentry, not a bug report.
// Only genuinely unexpected errors are reported.
function isReportable(err) {
  return !(err && err.isOperational);
}

function error(msg, err, context = {}) {
  base.error({ err, ...context }, msg);
  if (sentryEnabled && isReportable(err)) {
    Sentry.captureException(err, { extra: { msg, ...context } });
  }
}

function warn(msg, context = {}) {
  base.warn(context, msg);
}

function info(msg, context = {}) {
  base.info(context, msg);
}

function debug(msg, context = {}) {
  base.debug(context, msg);
}

module.exports = { error, warn, info, debug, pino: base, pinoOptions, scrubUrl, createHttpLogger };
