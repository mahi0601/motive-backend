const AppError = require('../utils/AppError');
const config = require('../config/env');
const logger = require('../config/logger');

// Translate well-known library errors into clean, client-safe responses.
function normalize(err) {
  if (err instanceof AppError) return err;

  // Prisma: unique constraint violation (e.g. email already registered)
  if (err.code === 'P2002') {
    const field = (err.meta?.target || ['field'])[0];
    return AppError.conflict(`${field} already in use`);
  }

  // Prisma: record required for the query was not found (update/delete by id)
  if (err.code === 'P2025') return AppError.notFound('Not found');

  // Prisma: malformed id / wrong type for a filter (roughly Mongoose's bad-ObjectId case)
  if (err.code === 'P2023') return AppError.badRequest('Invalid id');

  // JWT
  if (err.name === 'JsonWebTokenError') return AppError.unauthorized('Invalid token');
  if (err.name === 'TokenExpiredError') return AppError.unauthorized('Token expired');

  // Multer: upload exceeded the configured size limit.
  if (err.code === 'LIMIT_FILE_SIZE') return AppError.badRequest('File is too large');

  return err;
}

// eslint-disable-next-line no-unused-vars
module.exports = (err, _req, res, _next) => {
  const normalized = normalize(err);
  const statusCode = normalized.statusCode || 500;
  const isOperational = normalized.isOperational || statusCode < 500;

  // Log unexpected (non-operational) errors with full detail — via the raw
  // pino instance, not logger.error(), deliberately: server.js's
  // Sentry.setupExpressErrorHandler already runs before this middleware and
  // has already reported this exact error to Sentry, so calling
  // logger.error() here (which also reports) would double-report the same
  // exception. This still gets the structured stdout/Logtail logging.
  if (!isOperational) {
    logger.pino.error({ err }, 'Unhandled error');
  }

  res.status(statusCode).json({
    success: false,
    message: isOperational ? normalized.message : 'Internal server error',
    // Surface stack only outside production to aid debugging.
    ...(config.isProd ? {} : { stack: err.stack }),
  });
};
