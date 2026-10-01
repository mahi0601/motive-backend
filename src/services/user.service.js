const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const { comparePassword } = require('../utils/password.util');

// `hasPassword` tells the client which confirmation the delete-account flow
// needs (password vs. typing the account email — see deleteAccount). Derived
// here so the hash itself never leaves the service layer.
exports.getProfile = async (userId) => {
  const user = await prisma.user.findUnique({ where: { id: userId }, omit: { password: false } });
  if (!user) return null;
  const { password, ...safe } = user;
  return { ...safe, hasPassword: !!password };
};

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
//
// The one thing that cascade can't be allowed to do blindly: `Workspace.owner`
// is also `onDelete: Cascade` (schema.prisma), so deleting the owner of a
// workspace deletes the whole workspace — every other member's access, every
// task and page under it, gone with them. That was a latent bug even before
// the invite lifecycle existed; now that inviting real teammates is a normal
// thing to do, it's a routine way to accidentally destroy a team's data, not
// an edge case. Block it here instead of teaching every future feature to
// route around a personal-account operation with a team-wide blast radius.
//
// Confirmation: an account with a password must re-enter it. A Google-only
// account (see auth.service.js#loginWithGoogle) has no password — bcrypt.compare
// would throw on a null hash — so it confirms by typing its own account email
// instead. That's a deliberate confirmation step, weaker than a password: it
// guards against an accidental click, not against someone who already holds
// a live session for the account.
exports.deleteAccount = async (userId, password, confirmEmail) => {
  const user = await prisma.user.findUnique({ where: { id: userId }, omit: { password: false } });
  if (!user) throw AppError.notFound('User not found');

  if (user.password) {
    if (typeof password !== 'string' || !password) throw AppError.badRequest('Password is required to delete your account');
    const valid = await comparePassword(password, user.password);
    if (!valid) throw AppError.unauthorized('Incorrect password');
  } else {
    const typed = typeof confirmEmail === 'string' ? confirmEmail.trim().toLowerCase() : '';
    if (!typed || typed !== user.email.toLowerCase()) {
      throw AppError.badRequest('Type your account email exactly to confirm deleting your account');
    }
  }

  const ownedWithOthers = await prisma.workspace.findMany({
    where: { ownerId: userId, members: { some: { userId: { not: userId } } } },
    select: { name: true },
  });
  if (ownedWithOthers.length > 0) {
    const names = ownedWithOthers.map((w) => w.name).join(', ');
    throw AppError.badRequest(
      `You own ${ownedWithOthers.length > 1 ? 'workspaces that have' : 'a workspace that has'} other members (${names}) — remove them from Settings first, or contact support to transfer ownership, before deleting your account.`
    );
  }

  await prisma.user.delete({ where: { id: userId } });
  return { deleted: true };
};
