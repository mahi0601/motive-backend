const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const { verifyToken } = require('../utils/jwt.util');
const { hashPassword, comparePassword } = require('../utils/password.util');
const tokenService = require('./token.service');

// Password is globally omitted by the Prisma client (see config/prisma.js),
// so any `user` object here is already safe to send to the client as-is.
const result = (user) => ({
  user,
  ...tokenService.issueTokens(user),
});

exports.register = async ({ name, email, password }) => {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw AppError.conflict('Email already in use');

  const user = await prisma.user.create({
    data: { name, email, password: await hashPassword(password) },
  });
  return result(user);
};

exports.login = async ({ email, password }) => {
  // Password is globally omitted — opt back in just for this check.
  const user = await prisma.user.findUnique({ where: { email }, omit: { password: false } });
  if (!user) throw AppError.unauthorized('Invalid credentials');
  const valid = await comparePassword(password, user.password);
  if (!valid) throw AppError.unauthorized('Invalid credentials');

  delete user.password;
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

  const user = await prisma.user.findUnique({ where: { id: payload.id } });
  if (!user) throw AppError.unauthorized('User no longer exists');

  // tokenVersion mismatch → token was revoked (logout / password change elsewhere).
  if (payload.ver !== user.tokenVersion) throw AppError.unauthorized('Refresh token revoked');

  return result(user);
};

// Revoke ALL refresh tokens for the user by bumping their version.
exports.revokeAll = async (userId) => {
  if (!userId) return;
  await prisma.user.update({ where: { id: userId }, data: { tokenVersion: { increment: 1 } } });
};
