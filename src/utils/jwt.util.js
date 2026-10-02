const jwt = require('jsonwebtoken');
const config = require('../config/env');

// No insecure fallback secret — config.js guarantees JWT_SECRET exists at boot.
//
// Every token is signed HS256 with this API's issuer and audience, and verified
// with the algorithm PINNED to HS256 and the issuer/audience required. The "alg"
// header of an incoming token is attacker-controlled, so it is never trusted to
// choose how the token is checked.
const SIGN = () => ({ algorithm: 'HS256', issuer: config.jwt.issuer, audience: config.jwt.audience });
const VERIFY = () => ({ algorithms: ['HS256'], issuer: config.jwt.issuer, audience: config.jwt.audience });
// A `type` claim distinguishes access vs refresh tokens so one can't be used as the other.

// `sid` ties the token to a Session row (services/session.service.js) and
// `ver` to the user's tokenVersion, so revoking either one invalidates the
// token immediately instead of when it expires.
exports.signAccessToken = (userId, { sid, ver } = {}) =>
  jwt.sign({ id: userId, type: 'access', sid, ver }, config.jwt.secret, {
    ...SIGN(),
    expiresIn: config.jwt.accessExpiresIn,
  });

// Refresh token = which session (`sid`) and which rotation of it (`gen`).
// Only the httpOnly cookie ever holds it. Rotation, reuse detection and the
// cross-site defence for the endpoints that read it are explained in
// session.service.js and middlewares/sameSite.middleware.js.
exports.signRefreshToken = (userId, tokenVersion, sid, gen) =>
  jwt.sign({ id: userId, type: 'refresh', ver: tokenVersion, sid, gen }, config.jwt.refreshSecret, {
    ...SIGN(),
    expiresIn: config.jwt.refreshExpiresIn,
  });

// Password reset link. Short-lived, and carries the current `tokenVersion`
// (like the refresh token) so it's naturally single-use: resetting the
// password bumps the version, which invalidates this token along with every
// other outstanding session — and logging out everywhere invalidates any
// unused reset link too.
exports.signResetToken = (userId, tokenVersion) =>
  jwt.sign({ id: userId, type: 'reset', ver: tokenVersion }, config.jwt.secret, {
    ...SIGN(),
    expiresIn: '30m',
  });

// Email-verification link. Bound to the address it was sent to, so it cannot
// verify a different address if the account's email ever changes, and it is
// useless for anything else (every consumer checks `type`).
exports.signVerifyToken = (userId, email) =>
  jwt.sign({ id: userId, type: 'verify', email: String(email).toLowerCase() }, config.jwt.secret, {
    ...SIGN(),
    expiresIn: '24h',
  });

// Throws on invalid/expired tokens; the error middleware maps it to 401.
// `kind` picks the key: refresh tokens are checked with the refresh secret,
// everything else (access, reset, verify) with the main one. Callers still check
// the token's `type` claim afterwards.
exports.verifyToken = (token, kind = 'access') =>
  jwt.verify(token, kind === 'refresh' ? config.jwt.refreshSecret : config.jwt.secret, VERIFY());
