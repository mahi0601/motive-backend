const AppError = require('../utils/AppError');
const config = require('../config/env');

// Guards the two endpoints that act on the httpOnly refresh cookie
// (/auth/refresh and /auth/logout). The browser attaches that cookie to any
// request to this host, including one forged by another site, so these routes
// need proof the request came from this app's own pages:
//
//  1. A custom header. A cross-site <form> or <img> cannot set one, and fetch/
//     XHR cannot either unless the server's CORS policy allows that origin —
//     the preflight for it is answered only for the allowlist.
//  2. If the browser sent an Origin header (it always does on a cross-origin
//     POST), it must be on the same allowlist as CORS.
//
// This replaces the old per-login CSRF nonce, which lived only in page memory
// and so was lost on every reload — making reloads sign users out.
const REQUIRED_HEADER = 'x-requested-with';
const REQUIRED_VALUE = 'motive';

module.exports = (req, _res, next) => {
  if (req.get(REQUIRED_HEADER) !== REQUIRED_VALUE) {
    return next(AppError.forbidden('Missing required request header'));
  }
  const origin = req.get('origin');
  if (origin && !config.corsOrigins.includes(origin)) {
    return next(AppError.forbidden('Origin not allowed'));
  }
  next();
};
