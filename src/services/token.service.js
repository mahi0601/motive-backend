const config = require('../config/env');
const { signAccessToken, signRefreshToken } = require('../utils/jwt.util');
const sessionService = require('./session.service');

// Mint an access token (returned to the client in the response body) and a
// refresh token (httpOnly cookie only). `session` is an existing Session row
// when rotating; otherwise a new one is created — one per login.
exports.issueTokens = async (user, { userAgent, session, gen } = {}) => {
  const row = session || (await sessionService.create(user.id, userAgent));
  const g = gen ?? row.gen ?? 0;
  return {
    accessToken: signAccessToken(user.id, { sid: row.id, ver: user.tokenVersion }),
    refreshToken: signRefreshToken(user.id, user.tokenVersion, row.id, g),
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
