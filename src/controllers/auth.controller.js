const AuthService = require('../services/auth.service');
const tokenService = require('../services/token.service');
const asyncHandler = require('../utils/asyncHandler');

// Set the refresh cookie and return { user, accessToken }. The access token is
// kept in memory by the client; the refresh token lives only in the httpOnly cookie.
const sendAuth = (res, status, { user, accessToken, refreshToken }) => {
  tokenService.setRefreshCookie(res, refreshToken);
  res.status(status).json({ success: true, user, accessToken });
};

exports.register = asyncHandler(async (req, res) => {
  const { name, email, password } = req.body;
  const data = await AuthService.register({ name, email, password });
  sendAuth(res, 201, data);
});

exports.login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const data = await AuthService.login({ email, password });
  sendAuth(res, 200, data);
});

// Silent refresh: read the cookie, rotate the pair, return a new access token.
exports.refresh = asyncHandler(async (req, res) => {
  const token = tokenService.readRefreshCookie(req);
  const data = await AuthService.refresh(token);
  sendAuth(res, 200, data);
});

// Revoke all refresh tokens for the user, then clear the cookie.
exports.logout = asyncHandler(async (req, res) => {
  const token = tokenService.readRefreshCookie(req);
  if (token) {
    try {
      const { id } = require('../utils/jwt.util').verifyToken(token);
      await AuthService.revokeAll(id);
    } catch {
      /* expired/invalid cookie — still clear it below */
    }
  }
  tokenService.clearRefreshCookie(res);
  res.status(200).json({ success: true, message: 'Logged out' });
});
