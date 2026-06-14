/**
 * Operational error with an HTTP status code. Thrown deliberately by the app
 * (e.g. "not found", "forbidden") and rendered cleanly by the error middleware.
 * Anything that is NOT an AppError is treated as an unexpected 500.
 */
class AppError extends Error {
  constructor(message, statusCode = 500) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }

  static badRequest(msg = 'Bad request') {
    return new AppError(msg, 400);
  }
  static unauthorized(msg = 'Unauthorized') {
    return new AppError(msg, 401);
  }
  static forbidden(msg = 'Forbidden') {
    return new AppError(msg, 403);
  }
  static notFound(msg = 'Not found') {
    return new AppError(msg, 404);
  }
  static conflict(msg = 'Conflict') {
    return new AppError(msg, 409);
  }
}

module.exports = AppError;
