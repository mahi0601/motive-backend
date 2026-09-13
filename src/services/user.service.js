const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const { comparePassword } = require('../utils/password.util');

exports.getProfile = (userId) => prisma.user.findUnique({ where: { id: userId } });

exports.updateProfile = async (userId, data) => {
  // Whitelist updatable fields — never let a client patch password/email/tokenVersion here.
  const patch = {};
  ['name', 'avatar', 'timezone'].forEach((k) => {
    if (k in data) patch[k] = data[k];
  });
  try {
    return await prisma.user.update({ where: { id: userId }, data: patch });
  } catch (err) {
    if (err.code === 'P2025') throw AppError.notFound('User not found');
    throw err;
  }
};

// Delete the account and ALL data owned by the user. Every dependent table has
// an `onDelete: Cascade` FK back to User (or transitively to Task/Page), so a
// single delete replaces the old manual fan-out + transaction/session dance.
exports.deleteAccount = async (userId, password) => {
  const user = await prisma.user.findUnique({ where: { id: userId }, omit: { password: false } });
  if (!user) throw AppError.notFound('User not found');

  // A Google-only account (see auth.service.js#loginWithGoogle) has no
  // password to confirm with — bcrypt.compare would throw on a null hash.
  if (!user.password) {
    throw AppError.badRequest(
      'This account signed in with Google and has no password — contact support to delete it.'
    );
  }
  const valid = await comparePassword(password, user.password);
  if (!valid) throw AppError.unauthorized('Incorrect password');

  await prisma.user.delete({ where: { id: userId } });
  return { deleted: true };
};
