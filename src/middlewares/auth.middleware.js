const { verifyToken } = require('../utils/jwt.util');
const AppError = require('../utils/AppError');

module.exports = (req, _res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(AppError.unauthorized('No token provided'));

  try {
    const decoded = verifyToken(token); // { id, type, iat, exp }
    // Refresh tokens must never authenticate API calls.
    if (decoded.type !== 'access') throw AppError.unauthorized('Invalid token type');
    req.user = decoded;
    next();
  } catch (err) {
    next(err); // JWT errors are normalized to 401 by the error middleware
  }
};
