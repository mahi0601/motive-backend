require('dotenv').config();

// Fail fast at boot if critical config is missing or insecure, rather than
// discovering it on the first request in production.
const REQUIRED = ['MONGO_URI', 'JWT_SECRET'];

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
  mongoUri: process.env.MONGO_URI,
  jwt: {
    secret: process.env.JWT_SECRET,
    // Short-lived access token (Authorization header) + long-lived refresh token (httpOnly cookie).
    accessExpiresIn: process.env.ACCESS_TOKEN_TTL || '15m',
    refreshExpiresIn: process.env.REFRESH_TOKEN_TTL || '30d',
  },
  // Refresh-token cookie. Tune per hosting topology (see ARCHITECTURE_HARDENING.md):
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
};

module.exports = config;
