const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');

// Free tier: owner + 1 invited teammate (2 members total). Motive Pro
// removes the cap — the first thing `isPro` actually gates.
const FREE_MEMBER_LIMIT = 2;

// Returns the user's workspaces; creates a default one on first access.
exports.listForUser = async (userId) => {
  let workspaces = await prisma.workspace.findMany({
    where: { OR: [{ ownerId: userId }, { members: { some: { userId } } }] },
    include: { members: { include: { user: { select: { id: true, name: true, email: true } } } } },
    orderBy: { createdAt: 'asc' },
  });

  if (workspaces.length === 0) {
    const ws = await prisma.workspace.create({
      data: {
        name: 'My Workspace',
        ownerId: userId,
        members: { create: [{ userId, role: 'owner' }] },
      },
      include: { members: { include: { user: { select: { id: true, name: true, email: true } } } } },
    });
    workspaces = [ws];
  }
  return workspaces;
};

exports.getDefault = async (userId) => {
  const [ws] = await exports.listForUser(userId);
  return ws;
};

exports.create = (data, userId) =>
  prisma.workspace.create({
    data: {
      ...data,
      ownerId: userId,
      members: { create: [{ userId, role: 'owner' }] },
    },
    include: { members: { include: { user: { select: { id: true, name: true, email: true } } } } },
  });

// True if the user may access the workspace (owner or member).
exports.canAccess = async (workspaceId, userId) => {
  const ws = await prisma.workspace.findFirst({
    where: { id: workspaceId, OR: [{ ownerId: userId }, { members: { some: { userId } } }] },
  });
  return !!ws;
};

// Add an existing user (by email) as a workspace member — the only way a
// second real person ever ends up in someone's member list, since there's no
// other invite/sharing mechanism in the app. Owner-only.
exports.inviteMember = async (workspaceId, requesterId, email) => {
  const ws = await prisma.workspace.findFirst({ where: { id: workspaceId, ownerId: requesterId } });
  if (!ws) throw AppError.forbidden('Only the workspace owner can invite members');

  const requester = await prisma.user.findUnique({ where: { id: requesterId }, select: { isPro: true } });
  if (!requester.isPro) {
    const memberCount = await prisma.workspaceMember.count({ where: { workspaceId } });
    if (memberCount >= FREE_MEMBER_LIMIT) {
      throw AppError.paymentRequired(
        `Free workspaces are limited to ${FREE_MEMBER_LIMIT} members — upgrade to Motive Pro to invite more.`
      );
    }
  }

  const invitee = await prisma.user.findUnique({ where: { email } });
  if (!invitee) throw AppError.notFound('No user found with that email');

  const existing = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: invitee.id } },
  });
  if (existing) throw AppError.conflict('Already a member of this workspace');

  return prisma.workspaceMember.create({
    data: { workspaceId, userId: invitee.id, role: 'editor' },
    include: { user: { select: { id: true, name: true, email: true } } },
  });
};
