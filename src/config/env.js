require('dotenv').config();

// Fail fast at boot if critical config is missing or insecure, rather than
// discovering it on the first request in production.
const REQUIRED = ['DATABASE_URL', 'JWT_SECRET'];

const missing = REQUIRED.filter((key) => !process.env[key]);
if (missing.length) {
  console.error(`❌ Missing required env vars: ${missing.join(', ')}`);
  process.exit(1);
}

if (process.env.NODE_ENV === 'production' && process.env.JWT_SECRET.length < 32) {
  console.error('❌ JWT_SECRET must be at least 32 chars in production.');
  process.exit(1);
}

const config = {
  env: process.env.NODE_ENV || 'development',
  isProd: process.env.NODE_ENV === 'production',
  port: parseInt(process.env.PORT, 10) || 8080,
  databaseUrl: process.env.DATABASE_URL,
  jwt: {
    secret: process.env.JWT_SECRET,
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
    proPricing: {
      usd: { amount: parseInt(process.env.PRO_UPGRADE_PRICE_USD_CENTS, 10) || 999, label: '$9.99' },
      inr: { amount: parseInt(process.env.PRO_UPGRADE_PRICE_INR_PAISE, 10) || 79900, label: '₹799' },
    },
  },
  resend: {
    apiKey: process.env.RESEND_API_KEY || '',
    fromEmail: process.env.EMAIL_FROM || 'Motive <onboarding@resend.dev>',
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
  return cb(new Error(`CORS blocked for origin: ${origin}`));
};

// Payments are opt-in: only enforced when a payment route is actually hit
// (see payment.service.js), so the rest of the app still boots without Stripe configured.
if (config.isProd && (!config.stripe.secretKey || !config.stripe.webhookSecret)) {
  console.warn('⚠️  STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET not set — payment endpoints will fail.');
}

// Same opt-in pattern — password-reset emails just silently no-op without it
// (see email.service.js), rather than crashing the app at boot.
if (config.isProd && !config.resend.apiKey) {
  console.warn('⚠️  RESEND_API_KEY not set — password reset emails will not be sent.');
}

// Uploads fall back to local disk without this — fine for dev, but Render's
// disk is ephemeral, so uploaded files vanish on every deploy/restart in
// production without R2 configured (see storage.service.js).
if (config.isProd && !config.r2.bucket) {
  console.warn('⚠️  R2 storage not configured — uploads will use ephemeral local disk in production.');
}

// Sentry (see instrument.js / config/sentry.js) is opt-in the same way —
// the app runs fine without SENTRY_DSN, it just won't report errors anywhere.
if (config.isProd && !process.env.SENTRY_DSN) {
  console.warn('⚠️  SENTRY_DSN not set — errors will only be logged to stdout in production.');
}

// Google login is opt-in too — /api/auth/google 400s without it, everything
// else (including email/password auth) works the same either way.
if (config.isProd && !config.google.clientId) {
  console.warn('⚠️  GOOGLE_CLIENT_ID not set — "Continue with Google" will be unavailable.');
}

module.exports = config;
