const { verifyToken } = require('../utils/jwt.util');
const AppError = require('../utils/AppError');
const sessionService = require('../services/session.service');

module.exports = async (req, _res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(AppError.unauthorized('No token provided'));

  try {
    const decoded = verifyToken(token); // { id, type, sid, ver, iat, exp }
    // Refresh tokens must never authenticate API calls; the token must also
    // belong to a session that is still live (not logged out / revoked).
    await sessionService.assertAccessPayload(decoded);
    req.user = decoded;
    next();
  } catch (err) {
    next(err); // JWT errors are normalized to 401 by the error middleware
  }
};
