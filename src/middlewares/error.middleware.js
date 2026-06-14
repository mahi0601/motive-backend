const AppError = require('../utils/AppError');
const config = require('../config/env');

// Translate well-known library errors into clean, client-safe responses.
function normalize(err) {
  if (err instanceof AppError) return err;

  // Mongoose: bad ObjectId
  if (err.name === 'CastError') return AppError.badRequest(`Invalid ${err.path}`);

  // Mongoose: schema validation
  if (err.name === 'ValidationError') {
    const msg = Object.values(err.errors)
      .map((e) => e.message)
      .join(', ');
    return AppError.badRequest(msg);
  }

  // Mongo: duplicate key (e.g. email already registered)
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || { field: '' })[0];
    return AppError.conflict(`${field} already in use`);
  }

  // JWT
  if (err.name === 'JsonWebTokenError') return AppError.unauthorized('Invalid token');
  if (err.name === 'TokenExpiredError') return AppError.unauthorized('Token expired');

  return err;
}

// eslint-disable-next-line no-unused-vars
module.exports = (err, _req, res, _next) => {
  const normalized = normalize(err);
  const statusCode = normalized.statusCode || 500;
  const isOperational = normalized.isOperational || statusCode < 500;

  // Log unexpected (non-operational) errors with full detail.
  if (!isOperational) {
    console.error('💥 Unhandled error:', err);
  }

  res.status(statusCode).json({
    success: false,
    message: isOperational ? normalized.message : 'Internal server error',
    // Surface stack only outside production to aid debugging.
    ...(config.isProd ? {} : { stack: err.stack }),
  });
};
