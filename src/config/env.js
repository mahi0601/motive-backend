require('dotenv').config({ quiet: true });

// Fail fast at boot if critical config is missing or insecure, rather than
// discovering it on the first request in production.
const REQUIRED = ['DATABASE_URL', 'JWT_SECRET'];

const missing = REQUIRED.filter((key) => !process.env[key]);
if (missing.length) {
  console.error(`❌ Missing required env vars: ${missing.join(', ')}`);
  process.exit(1);
}

// Short signing secrets are tolerated only for local work. Anything that is not
// explicitly development or test (production, staging, a preview deploy, or a
// typo'd NODE_ENV) must use a real secret.
const isLocal = !process.env.NODE_ENV || ['development', 'test'].includes(process.env.NODE_ENV);
if (!isLocal && process.env.JWT_SECRET.length < 32) {
  console.error('❌ JWT_SECRET must be at least 32 chars outside development and test.');
  process.exit(1);
}
if (!isLocal && process.env.JWT_REFRESH_SECRET && process.env.JWT_REFRESH_SECRET.length < 32) {
  console.error('❌ JWT_REFRESH_SECRET must be at least 32 chars outside development and test.');
  process.exit(1);
}

const config = {
  env: process.env.NODE_ENV || 'development',
  isProd: process.env.NODE_ENV === 'production',
  port: parseInt(process.env.PORT, 10) || 8080,
  databaseUrl: process.env.DATABASE_URL,
  jwt: {
    secret: process.env.JWT_SECRET,
    // Refresh tokens can be signed with their own secret, so leaking one key does
    // not let anyone forge the other kind of token. Falls back to JWT_SECRET when
    // unset, so an existing deployment keeps working until it opts in.
    refreshSecret: process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET,
    // Who issued a token, and who it is for. Verification requires both, so a
    // token minted by another service that shares a secret is not accepted.
    issuer: process.env.JWT_ISSUER || 'clientglass-api',
    audience: process.env.JWT_AUDIENCE || 'clientglass-app',
    // Short-lived access token (Authorization header) + long-lived refresh token (httpOnly cookie).
    accessExpiresIn: process.env.ACCESS_TOKEN_TTL || '15m',
    refreshExpiresIn: process.env.REFRESH_TOKEN_TTL || '30d',
  },
  // Refresh-token cookie. Tune per hosting topology:
  //   same registrable domain  → sameSite 'lax'
  //   cross-site (diff domains) → sameSite 'none' + secure true (HTTPS required)
  cookie: {
    name: process.env.COOKIE_NAME || 'motive_rt',
    domain: process.env.COOKIE_DOMAIN || undefined,
    sameSite: process.env.COOKIE_SAMESITE || 'lax',
    // Defaults to true in production; SameSite=None always requires Secure.
    secure:
      process.env.COOKIE_SECURE != null
        ? process.env.COOKIE_SECURE === 'true'
        : process.env.NODE_ENV === 'production',
    // Cookie only travels to the auth endpoints — never on regular API calls.
    path: '/api/auth',
    maxAgeMs: 30 * 24 * 60 * 60 * 1000, // 30d, keep in sync with refreshExpiresIn
  },
  // Comma-separated allow-list, e.g. "https://app.com,https://www.app.com"
  corsOrigins: (process.env.FRONTEND_URL || 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  // Where Stripe Checkout redirects back to after payment.
  frontendUrl: (process.env.FRONTEND_URL || 'http://localhost:5173').split(',')[0].trim(),
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
    // Buyer picks the currency at checkout; each maps to a fixed price in the
    // smallest currency unit. Which payment methods actually render per currency
    // (cards, Google Pay, Apple Pay, UPI/PhonePe, ...) is a Stripe Dashboard +
    // account-country setting, not something this app controls.
    // Monthly prices per paid plan and currency, in the currency's smallest unit.
    // These defaults are PLACEHOLDERS until the numbers are checked with real
    // buyers; change them per environment. Keep the frontend's config/plans.js
    // (what the pricing page displays) in step with whatever is charged here.
    plans: {
      studio: {
        usd: { amount: parseInt(process.env.STUDIO_PRICE_USD_CENTS, 10) || 1900, label: '$19' },
        inr: { amount: parseInt(process.env.STUDIO_PRICE_INR_PAISE, 10) || 99900, label: '₹999' },
      },
      agency: {
        usd: { amount: parseInt(process.env.AGENCY_PRICE_USD_CENTS, 10) || 4900, label: '$49' },
        inr: { amount: parseInt(process.env.AGENCY_PRICE_INR_PAISE, 10) || 249900, label: '₹2,499' },
      },
    },
  },
  // Razorpay: takes INR payments (cards and UPI AutoPay) for subscribers in India, where
  // Stripe is invite-only. Optional: with no keys, INR falls back to Stripe. Prices are the
  // same STUDIO_/AGENCY_PRICE_*_INR_PAISE values above, so there is one place to change them.
  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID || '',
    keySecret: process.env.RAZORPAY_KEY_SECRET || '',
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || '',
    // Billing cycles a new subscription is created for (monthly, so 120 = ten years).
    totalCount: parseInt(process.env.RAZORPAY_TOTAL_COUNT, 10) || 120,
  },
  // PayPal subscriptions, USD only (PayPal does not take INR in India). Optional. `mode` is
  // 'sandbox' unless it is exactly 'live', so a missing or mistyped value can never charge real
  // money. `webhookId` is the id PayPal shows for the webhook you add in its developer dashboard.
  paypal: {
    clientId: process.env.PAYPAL_CLIENT_ID || '',
    clientSecret: process.env.PAYPAL_CLIENT_SECRET || '',
    webhookId: process.env.PAYPAL_WEBHOOK_ID || '',
    mode: process.env.PAYPAL_MODE === 'live' ? 'live' : 'sandbox',
  },
  // Cashfree subscriptions, INR only. Optional. `mode` is 'sandbox' unless exactly 'production'.
  // Its webhooks are signed with the client secret, so there is no separate webhook secret.
  cashfree: {
    clientId: process.env.CASHFREE_CLIENT_ID || '',
    clientSecret: process.env.CASHFREE_CLIENT_SECRET || '',
    mode: process.env.CASHFREE_MODE === 'production' ? 'production' : 'sandbox',
    apiVersion: process.env.CASHFREE_API_VERSION || '2025-01-01',
    maxCycles: parseInt(process.env.CASHFREE_MAX_CYCLES, 10) || 120,
  },
  // Order in which the available gateways are offered per currency (first = preselected).
  // Comma-separated ids; unknown or unconfigured ones are skipped.
  paymentOrder: {
    usd: (process.env.PAYMENT_PROVIDER_ORDER_USD || 'stripe,paypal').split(',').map((s) => s.trim()).filter(Boolean),
    inr: (process.env.PAYMENT_PROVIDER_ORDER_INR || 'razorpay,cashfree,stripe').split(',').map((s) => s.trim()).filter(Boolean),
  },
  resend: {
    apiKey: process.env.RESEND_API_KEY || '',
    fromEmail: process.env.EMAIL_FROM || 'Clientglass <onboarding@resend.dev>',
  },
  // Cloudflare R2 (S3-compatible). Optional — see storage.service.js: when
  // unset, uploads fall back to local disk (fine for dev, NOT for
  // production on Render, whose disk is ephemeral and wiped every deploy).
  r2: {
    accountId: process.env.R2_ACCOUNT_ID || '',
    accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
    bucket: process.env.R2_BUCKET_NAME || '',
    // The bucket's public base URL — either R2's own r2.dev subdomain or a
    // custom domain you've mapped to the bucket.
    publicUrl: process.env.R2_PUBLIC_URL || '',
  },
  // Google OAuth login. Optional — without it, /api/auth/google just 400s;
  // email/password auth is unaffected. Create credentials at
  // https://console.cloud.google.com/apis/credentials — "Web application"
  // type, with an Authorized redirect URI matching GOOGLE_REDIRECT_URI below
  // exactly (e.g. https://your-api.example.com/api/auth/google/callback).
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    redirectUri: process.env.GOOGLE_REDIRECT_URI || '',
  },
};

// Shared by both the HTTP CORS middleware (server.js) and Socket.io's CORS
// option (sockets/socket.handler.js) — previously each hand-rolled an
// identical copy of this check against `corsOrigins`.
config.corsOriginCheck = (origin, cb) => {
  if (!origin || config.corsOrigins.includes(origin)) return cb(null, true);
  // A plain Error would surface as a 500 (and page Sentry) for what is just a
  // disallowed caller; mark it as the client error it is.
  const err = new Error(`CORS blocked for origin: ${origin}`);
  err.statusCode = 403;
  err.isOperational = true;
  return cb(err);
};

// This API's own public base URL — used to build absolute links that must
// point back at this service (currently just the local-disk upload URL in
// storage.service.js; R2 already builds an absolute URL from R2_PUBLIC_URL
// regardless of host). Previously that URL was built from the *request's*
// protocol/Host header, which a client fully controls — a forged Host wrote
// an attacker-chosen absolute URL into the File.url column, later rendered
// to other users. RENDER_EXTERNAL_URL is auto-injected by Render on every
// service; PUBLIC_API_URL overrides it for any other host. Falls back to
// localhost for docker-compose / local dev, where the port is known.
config.publicApiUrl = (
  process.env.PUBLIC_API_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  `http://localhost:${config.port}`
).replace(/\/$/, '');

// Required by ./logger only from here on — logger.js has no dependency back
// on this module (it reads process.env directly, see its own comment), so
// this isn't circular; it's just placed after `config` exists so the
// warnings below can go through it instead of raw console.warn.
const logger = require('./logger');

// Payments are opt-in: only enforced when a payment route is actually hit
// (see payment.service.js), so the rest of the app still boots without Stripe configured.
if (config.isProd && (!config.stripe.secretKey || !config.stripe.webhookSecret)) {
  logger.warn('STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET not set — payment endpoints will fail.');
}

// Same opt-in pattern — password-reset emails just silently no-op without it
// (see email.service.js), rather than crashing the app at boot.
if (config.isProd && !config.resend.apiKey) {
  logger.warn('RESEND_API_KEY not set — password reset emails will not be sent.');
}

// Uploads fall back to local disk without this — fine for dev, but Render's
// disk is ephemeral, so uploaded files vanish on every deploy/restart in
// production without R2 configured (see storage.service.js).
if (config.isProd && !config.r2.bucket) {
  logger.warn('R2 storage not configured — uploads will use ephemeral local disk in production.');
}

// Sentry (see instrument.js / config/sentry.js) is opt-in the same way —
// the app runs fine without SENTRY_DSN, it just won't report errors anywhere.
if (config.isProd && !process.env.SENTRY_DSN) {
  logger.warn('SENTRY_DSN not set — errors will only be logged to stdout in production.');
}

// Google login is opt-in too — /api/auth/google 400s without it, everything
// else (including email/password auth) works the same either way.
if (config.isProd && !config.google.clientId) {
  logger.warn('GOOGLE_CLIENT_ID not set — "Continue with Google" will be unavailable.');
}

module.exports = config;
