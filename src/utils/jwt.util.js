const jwt = require('jsonwebtoken');
const config = require('../config/env');

// No insecure fallback secret — config.js guarantees JWT_SECRET exists at boot.
// A `type` claim distinguishes access vs refresh tokens so one can't be used as the other.

exports.signAccessToken = (userId) =>
  jwt.sign({ id: userId, type: 'access' }, config.jwt.secret, {
    expiresIn: config.jwt.accessExpiresIn,
  });

exports.signRefreshToken = (userId, tokenVersion) =>
  jwt.sign({ id: userId, type: 'refresh', ver: tokenVersion }, config.jwt.secret, {
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
