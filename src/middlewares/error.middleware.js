const AppError = require('../utils/AppError');
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

  // Prisma: the query's arguments were malformed or of the wrong type (e.g. a
  // bad enum value or a non-date string that slipped past route validation).
  // That's bad client input, not a server fault — a 400, not a 500 that pages
  // Sentry.
  if (err.name === 'PrismaClientValidationError') return AppError.badRequest('Invalid request data');

  // Prisma: a value didn't fit its column (P2000), or a referenced record
  // doesn't exist (P2003, e.g. an assigneeId/parentId pointing at nothing).
  if (err.code === 'P2000') return AppError.badRequest('A value is too long');
  if (err.code === 'P2003') return AppError.badRequest('A referenced record does not exist');

  // JWT
  if (err.name === 'JsonWebTokenError') return AppError.unauthorized('Invalid token');
  if (err.name === 'TokenExpiredError') return AppError.unauthorized('Token expired');

  // Multer: upload exceeded the configured size limit.
  if (err.code === 'LIMIT_FILE_SIZE') return AppError.badRequest('File is too large');

  return err;
}

// Runs BEFORE Sentry's express error handler (see app.js): Sentry reports any
// error that reaches it without a sub-500 status, so translating client-input
// errors into 4xx AppErrors first keeps them out of Sentry entirely.
const normalizeErrors = (err, _req, _res, next) => next(normalize(err));

// eslint-disable-next-line no-unused-vars
const errorHandler = (err, _req, res, _next) => {
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
    // Stack traces only when developing or testing: a staging or preview deploy with some other
    // NODE_ENV must not hand them to callers either.
    ...(['development', 'test'].includes(process.env.NODE_ENV) ? { stack: err.stack } : {}),
  });
};

module.exports = errorHandler;
module.exports.normalizeErrors = normalizeErrors;
module.exports.normalize = normalize;
