const jwt = require('jsonwebtoken');
const config = require('../config/env');

// No insecure fallback secret — config.js guarantees JWT_SECRET exists at boot.
// A `type` claim distinguishes access vs refresh tokens so one can't be used as the other.

exports.signAccessToken = (userId) =>
  jwt.sign({ id: userId, type: 'access' }, config.jwt.secret, {
    expiresIn: config.jwt.accessExpiresIn,
  });

// `csrf` is a random nonce, opaque to the client except that the exact same
// value is handed back to it once, in the JSON body of whichever call
// issued this token (see token.service.js#issueTokens) — never in a
// cookie. That split is what makes it a working CSRF defense even though
// the frontend and API are on different origins in production: a
// cross-site forged request gets the httpOnly refresh cookie attached
// automatically by the browser, but has no way to also know this value, so
// it can't produce a matching X-CSRF-Token header. See
// auth.service.js#refresh/#logout for where it's actually checked.
exports.signRefreshToken = (userId, tokenVersion, csrf) =>
  jwt.sign({ id: userId, type: 'refresh', ver: tokenVersion, csrf }, config.jwt.secret, {
    expiresIn: config.jwt.refreshExpiresIn,
  });

// Password reset link. Short-lived, and carries the current `tokenVersion`
// (like the refresh token) so it's naturally single-use: resetting the
// password bumps the version, which invalidates this token along with every
// other outstanding session — and logging out everywhere invalidates any
// unused reset link too.
exports.signResetToken = (userId, tokenVersion) =>
  jwt.sign({ id: userId, type: 'reset', ver: tokenVersion }, config.jwt.secret, {
    expiresIn: '30m',
  });

// Throws on invalid/expired tokens; the error middleware maps it to 401.
exports.verifyToken = (token) => jwt.verify(token, config.jwt.secret);
