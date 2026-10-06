const AppError = require('../utils/AppError');
const config = require('../config/env');

// Guards the endpoints that start a session from credentials (login, register, native-exchange).
// A cross-site <form> can only send urlencoded, multipart or text/plain bodies (anything else needs a
// CORS preflight, answered only for the allowlist), so requiring JSON stops a forged form from
// signing a victim in as the attacker ("login CSRF"). If the browser sent an Origin it must also be
// on the CORS allowlist.
module.exports = (req, _res, next) => {
  if (!req.is('application/json')) return next(AppError.badRequest('Content-Type must be application/json'));
  const origin = req.get('origin');
  if (origin && !config.corsOrigins.includes(origin)) return next(AppError.forbidden('Origin not allowed'));
  next();
};
