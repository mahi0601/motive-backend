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
      '*.password',
      '*.token',
      '*.email',
      'email',
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

module.exports = { error, warn, info, debug, pino: base };
