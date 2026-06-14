const config = require('../config/env');
const { signAccessToken, signRefreshToken } = require('../utils/jwt.util');

// Mint an access token (returned to the client) + a refresh token (set as cookie).
exports.issueTokens = (user) => ({
  accessToken: signAccessToken(user._id),
  refreshToken: signRefreshToken(user._id, user.tokenVersion),
});

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
