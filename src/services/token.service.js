const crypto = require('crypto');
const config = require('../config/env');
const { signAccessToken, signRefreshToken } = require('../utils/jwt.util');

// Mint an access token (returned to the client) + a refresh token (set as
// cookie) + a CSRF nonce embedded in the refresh token and ALSO returned
// directly to the client — see jwt.util.js#signRefreshToken for why that
// split is the actual CSRF defense.
exports.issueTokens = (user) => {
  const csrfToken = crypto.randomBytes(16).toString('hex');
  return {
    accessToken: signAccessToken(user.id),
    refreshToken: signRefreshToken(user.id, user.tokenVersion, csrfToken),
    csrfToken,
  };
};

const cookieOptions = () => ({
  httpOnly: true, // not readable by JS → immune to XSS token theft
  secure: config.cookie.secure, // HTTPS only (mandatory for SameSite=None)
  sameSite: config.cookie.sameSite, // 'lax' (same-site) | 'none' (cross-site)
  domain: config.cookie.domain, // e.g. '.motive.com' to share across subdomains
  path: config.cookie.path, // '/api/auth' → cookie only sent to auth routes
});

exports.setRefreshCookie = (res, token) => {
  res.cookie(config.cookie.name, token, {
    ...cookieOptions(),
    maxAge: config.cookie.maxAgeMs,
  });
};

exports.clearRefreshCookie = (res) => {
  // Must match the attributes used when setting, or the browser won't clear it.
  res.clearCookie(config.cookie.name, cookieOptions());
};

exports.readRefreshCookie = (req) => req.cookies?.[config.cookie.name];
