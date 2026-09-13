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

// Role sufficiency, not just membership — the foundation the B2B2C
// permission model builds on (see PLAN "Total scope" §A). `owner` and
// `editor` can write; only `owner`/`editor`/`viewer` (i.e. any member) can
// read. Ranked so a call site never has to enumerate which roles satisfy
// which need — it just states what it requires.
const ROLE_RANK = { viewer: 0, editor: 1, owner: 2 };
const NEED_RANK = { read: 0, write: 1 };

// The caller's role in a workspace, or null if they aren't a member at all
// (including a non-existent workspaceId). `owner` is derived from
// `Workspace.ownerId` directly rather than requiring a matching
// WorkspaceMember row — every workspace has exactly one owner and it's
// always this field, not a role value stored in the member table.
exports.getRole = async (workspaceId, userId) => {
  if (!workspaceId) return null;
  const ws = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { ownerId: true, members: { where: { userId }, select: { role: true } } },
  });
  if (!ws) return null;
  if (ws.ownerId === userId) return 'owner';
  return ws.members[0]?.role ?? null;
};

// True if the user's role in the workspace is sufficient for `need`
// ('read', the default — preserves every existing caller's behavior
// unchanged, since 'read' was the only thing the old boolean-membership
// check ever meant — or 'write'). A viewer can read but never write; an
// editor or owner can do both.
exports.canAccess = async (workspaceId, userId, need = 'read') => {
  const role = await exports.getRole(workspaceId, userId);
  if (!role) return false;
  return ROLE_RANK[role] >= NEED_RANK[need];
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
