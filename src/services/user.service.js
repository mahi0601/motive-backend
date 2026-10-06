const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const { comparePassword } = require('../utils/password.util');
const paymentService = require('./payment.service');
const workspaceService = require('./workspace.service');
const storageService = require('./storage.service');
const logger = require('../config/logger');
const audit = require('./audit.service');
const { TERMS_VERSION } = require('../config/legal');
const { effectivePlan } = require('../utils/plans');

// `hasPassword` tells the client which confirmation the delete-account flow
// needs (password vs. typing the account email — see deleteAccount). Derived
// here so the hash itself never leaves the service layer.
exports.getProfile = async (userId) => {
  const user = await prisma.user.findUnique({ where: { id: userId }, omit: { password: false } });
  if (!user) return null;
  const { password, ...safe } = user;
  // `tier` is what the account is entitled to right now (see utils/plans.js);
  // the raw `plan` column is only a record of the last purchase.
  return { ...safe, hasPassword: !!password, tier: effectivePlan(safe) };
};

// Records that the person agreed to the Terms and Privacy Policy (16 or older), for an
// account that had no sign-up checkbox (a new Google account). The time and version are
// set here, never taken from the caller, and an agreement already on record is not
// rewritten, so the original time stays the evidence.
exports.acceptTerms = async (userId) => {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { termsAcceptedAt: true } });
  if (!user) throw AppError.notFound('User not found');
  if (!user.termsAcceptedAt) {
    await prisma.user.update({ where: { id: userId }, data: { termsAcceptedAt: new Date(), termsVersion: TERMS_VERSION, termsPending: false } });
    await audit.record({ type: 'terms_accepted', actorId: userId, meta: { version: TERMS_VERSION } });
  } else {
    await prisma.user.update({ where: { id: userId }, data: { termsPending: false } });
  }
  return exports.getProfile(userId);
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

// Everything the account owns or authored, for "download my data". Built from
// explicit field lists, so a column added to a model later is NOT exported (or
// leaked) by accident, and so nothing belonging to another person — their
// tasks, comments, or emails — comes along just because it shares a workspace.
exports.exportData = async (userId) => {
  const user = await prisma.user.findUnique({ where: { id: userId }, omit: { password: false } });
  if (!user) throw AppError.notFound('User not found');

  const [workspaces, tasks, pages, comments, files, notifications, activity, templates, clientFeedback] = await Promise.all([
    prisma.workspaceMember.findMany({
      where: { userId },
      select: {
        role: true,
        workspace: {
          select: { id: true, name: true, icon: true, ownerId: true, milestones: { orderBy: { position: 'asc' }, select: { title: true, date: true } } },
        },
      },
    }),
    // What they created is exported, but the CURRENT content of a workspace they no longer belong to
    // (other people's subtasks and blocks) is not: those rows come without it.
    prisma.task.findMany({
      where: { userId },
      include: {
        subtasks: {
          where: { task: workspaceService.ownReachable(userId, 'userId') },
        },
      },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.page.findMany({
      where: { ownerId: userId },
      include: {
        blocks: {
          where: { page: workspaceService.ownReachable(userId, 'ownerId') },
          orderBy: { position: 'asc' },
        },
      },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.comment.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.file.findMany({
      where: { uploadedBy: userId },
      select: {
        id: true,
        name: true,
        url: true,
        taskId: true,
        createdAt: true,
      },
    }),
    prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.activityLog.findMany({
      where: { userId },
      orderBy: { timestamp: 'asc' },
    }),
    prisma.template.findMany({ where: { ownerId: userId } }),
    // What clients sent through the status pages of workspaces this user owns.
    prisma.clientFeedback.findMany({
      where: { workspace: { ownerId: userId } },
      select: { kind: true, authorName: true, message: true, milestoneTitle: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),
  ]);

  await audit.record({ type: 'data_exported', actorId: userId });
  return {
    exportedAt: new Date().toISOString(),
    profile: {
      id: user.id,
      name: user.name,
      email: user.email,
      avatar: user.avatar,
      timezone: user.timezone,
      createdAt: user.createdAt,
      termsAcceptedAt: user.termsAcceptedAt,
      termsVersion: user.termsVersion,
      signInMethods: [user.password ? 'password' : null, user.googleId ? 'google' : null].filter(Boolean),
      plan: { tier: effectivePlan(user), isPro: user.isPro, lifetime: user.proLifetime, subscriptionStatus: user.subscriptionStatus, periodEnd: user.proPeriodEnd },
    },
    // Milestones belong to whoever owns the page, so they are exported only for
    // workspaces this person owns.
    workspaces: workspaces.map(({ role, workspace: { milestones, ...ws } }) => {
      const owned = ws.ownerId === userId;
      return { ...ws, role: owned ? 'owner' : role, ...(owned ? { milestones } : {}) };
    }),
    tasks,
    pages,
    comments,
    files,
    notifications,
    activity,
    templates,
    clientFeedback,
  };
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

  // Order matters. 1) Stop billing first and refuse to continue if that fails —
  // deleting the account while Stripe keeps charging it is the one outcome that
  // can't be walked back. 2) Remember which stored objects the cascade is about
  // to orphan. 3) Delete the rows. 4) Only then remove the objects, best effort:
  // the rows are already gone, so a storage hiccup must not fail the request.
  await paymentService.cancelSubscriptionForUser(userId);

  // Work this person did inside someone ELSE's workspace belongs to that workspace: the cascade
  // would delete a client's tasks, pages and uploads along with the member who made them. Hand them
  // to the workspace owner first. (Comments are personal words, so they are still deleted with them.)
  const memberships = await prisma.workspaceMember.findMany({
    where: { userId, workspace: { ownerId: { not: userId } } },
    select: { workspaceId: true, workspace: { select: { ownerId: true } } },
  });
  await prisma.$transaction(
    memberships.flatMap(({ workspaceId, workspace }) => [
      prisma.task.updateMany({
        where: { userId, workspaceId },
        data: { userId: workspace.ownerId },
      }),
      prisma.page.updateMany({
        where: { ownerId: userId, workspaceId },
        data: { ownerId: workspace.ownerId },
      }),
      prisma.file.updateMany({
        where: { uploadedBy: userId, task: { workspaceId } },
        data: { uploadedBy: workspace.ownerId },
      }),
    ]),
  );

  const files = await prisma.file.findMany({
    where: { OR: [{ uploadedBy: userId }, { task: { userId } }, { task: { workspace: { ownerId: userId } } }] },
    select: { url: true },
  });

  await prisma.user.delete({ where: { id: userId } });
  require('../sockets/revoke').disconnectUser(userId);
  await audit.record({ type: 'account_deleted', targetUserId: userId, meta: { files: files.length } });

  await Promise.allSettled(files.map((f) => storageService.deleteFile(f.url))).then((results) => {
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed) logger.warn('Some files could not be removed after account deletion', { failed, total: files.length });
  });
  return { deleted: true };
};
