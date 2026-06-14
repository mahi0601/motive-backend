const User = require('../models/user.model');
const AppError = require('../utils/AppError');
const { verifyToken } = require('../utils/jwt.util');
const tokenService = require('./token.service');

const result = (user) => ({
  user: user.toJSON(), // strips password hash (see user.model.js)
  ...tokenService.issueTokens(user),
});

exports.register = async ({ name, email, password }) => {
  const existing = await User.findOne({ email });
  if (existing) throw AppError.conflict('Email already in use');
  // Password hashed by the model's pre-save hook — never here.
  const user = await User.create({ name, email, password });
  return result(user);
};

exports.login = async ({ email, password }) => {
  const user = await User.findOne({ email }).select('+password');
  if (!user) throw AppError.unauthorized('Invalid credentials');
  const valid = await user.comparePassword(password);
  if (!valid) throw AppError.unauthorized('Invalid credentials');
  return result(user);
};

// Validate a refresh token and rotate it (issue a fresh pair).
exports.refresh = async (refreshToken) => {
  if (!refreshToken) throw AppError.unauthorized('No refresh token');

  let payload;
  try {
    payload = verifyToken(refreshToken);
  } catch {
    throw AppError.unauthorized('Invalid refresh token');
  }
  if (payload.type !== 'refresh') throw AppError.unauthorized('Invalid token type');

  const user = await User.findById(payload.id);
  if (!user) throw AppError.unauthorized('User no longer exists');

  // tokenVersion mismatch → token was revoked (logout / password change elsewhere).
  if (payload.ver !== user.tokenVersion) throw AppError.unauthorized('Refresh token revoked');

  return result(user);
};

// Revoke ALL refresh tokens for the user by bumping their version.
exports.revokeAll = async (userId) => {
  if (!userId) return;
  await User.findByIdAndUpdate(userId, { $inc: { tokenVersion: 1 } });
};
