const crypto = require('crypto');
const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const emailService = require('./email.service');
const config = require('../config/env');

// Free tier: owner + 1 invited teammate (2 members total). Motive Pro
// removes the cap — the first thing `isPro` actually gates.
const FREE_MEMBER_LIMIT = 2;

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// A DB-backed token (hash stored, raw only ever in the email) rather than a
// signed JWT like jwt.util.js#signResetToken — a stateless JWT can't be
// revoked or show up as "invited 2 days ago" in the Members tab; a row can.
const newInviteToken = () => {
  const raw = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, tokenHash };
};

// Allowlist, not a denylist — an invite's tokenHash must never leave this
// service in an API response, and an explicit "what's safe" list can't
// accidentally start leaking a field added to the model later the way an
// omit-one-field destructure could.
const safeInviteFields = (invite) => ({
  id: invite.id,
  workspaceId: invite.workspaceId,
  email: invite.email,
  role: invite.role,
  status: invite.status,
  invitedById: invite.invitedById,
  expiresAt: invite.expiresAt,
  createdAt: invite.createdAt,
  updatedAt: invite.updatedAt,
});

const sendInviteEmail = async (invite, workspace, inviterName, rawToken) => {
  const acceptUrl = `${config.frontendUrl}/invite/${rawToken}`;
  await emailService.sendEmail({
    to: invite.email,
    subject: `You're invited to join ${workspace.name} on Motive`,
    html: `<p>${inviterName} invited you to join <strong>${workspace.name}</strong> on Motive as ${invite.role === 'viewer' ? 'a viewer' : 'an editor'}.</p>
<p><a href="${acceptUrl}">Click here to accept the invite</a>. This link expires in 7 days.</p>
<p>If you weren't expecting this, you can safely ignore this email.</p>`,
  });
};

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

// Assert the requester owns this workspace, returning it. The same
// owner-only check every invite/member-management function below needs —
// pulled out since it used to be inlined once in the old inviteMember and
// now guards six call sites.
const assertOwner = async (workspaceId, requesterId) => {
  const ws = await prisma.workspace.findFirst({ where: { id: workspaceId, ownerId: requesterId } });
  if (!ws) throw AppError.forbidden('Only the workspace owner can do that');
  return ws;
};

// Invite someone by email — unlike the old inviteMember, they don't need an
// account yet. A re-invite to the same email recycles the existing row
// (new token, reset expiry) rather than erroring, via the
// `[workspaceId, email]` unique constraint.
exports.createInvite = async (workspaceId, requesterId, email, role = 'editor') => {
  const ws = await assertOwner(workspaceId, requesterId);
  const normalizedEmail = email.toLowerCase();

  const requester = await prisma.user.findUnique({ where: { id: requesterId }, select: { name: true, isPro: true } });
  if (!requester.isPro) {
    const memberCount = await prisma.workspaceMember.count({ where: { workspaceId } });
    if (memberCount >= FREE_MEMBER_LIMIT) {
      throw AppError.paymentRequired(
        `Free workspaces are limited to ${FREE_MEMBER_LIMIT} members — upgrade to Motive Pro to invite more.`
      );
    }
  }

  const existingMember = await prisma.user.findUnique({ where: { email: normalizedEmail }, select: { id: true } });
  if (existingMember) {
    const already = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: existingMember.id } },
    });
    if (already) throw AppError.conflict('Already a member of this workspace');
  }

  const { raw, tokenHash } = newInviteToken();
  const invite = await prisma.workspaceInvite.upsert({
    where: { workspaceId_email: { workspaceId, email: normalizedEmail } },
    create: {
      workspaceId,
      email: normalizedEmail,
      role,
      tokenHash,
      status: 'pending',
      invitedById: requesterId,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    },
    update: {
      role,
      tokenHash,
      status: 'pending',
      invitedById: requesterId,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    },
  });

  await sendInviteEmail(invite, ws, requester.name, raw);
  return safeInviteFields(invite);
};

exports.listInvites = async (workspaceId, requesterId) => {
  await assertOwner(workspaceId, requesterId);
  const invites = await prisma.workspaceInvite.findMany({
    where: { workspaceId, status: 'pending' },
    orderBy: { createdAt: 'desc' },
  });
  return invites.map(safeInviteFields);
};

exports.resendInvite = async (workspaceId, inviteId, requesterId) => {
  const ws = await assertOwner(workspaceId, requesterId);
  const requester = await prisma.user.findUnique({ where: { id: requesterId }, select: { name: true } });
  const existing = await prisma.workspaceInvite.findFirst({ where: { id: inviteId, workspaceId } });
  if (!existing) throw AppError.notFound('Invite not found');

  const { raw, tokenHash } = newInviteToken();
  const invite = await prisma.workspaceInvite.update({
    where: { id: inviteId },
    data: { tokenHash, status: 'pending', expiresAt: new Date(Date.now() + INVITE_TTL_MS) },
  });
  await sendInviteEmail(invite, ws, requester.name, raw);
  return safeInviteFields(invite);
};

exports.revokeInvite = async (workspaceId, inviteId, requesterId) => {
  await assertOwner(workspaceId, requesterId);
  const existing = await prisma.workspaceInvite.findFirst({ where: { id: inviteId, workspaceId } });
  if (!existing) throw AppError.notFound('Invite not found');
  await prisma.workspaceInvite.update({ where: { id: inviteId }, data: { status: 'revoked' } });
};

// Public metadata for the /invite/:token landing page — deliberately never
// returns the workspace's internal id, its other members, or the token hash.
exports.getInviteByToken = async (rawToken) => {
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const invite = await prisma.workspaceInvite.findUnique({
    where: { tokenHash },
    include: { workspace: { select: { name: true, icon: true } }, invitedBy: { select: { name: true } } },
  });
  if (!invite) throw AppError.notFound('This invite link is invalid');
  return {
    workspaceName: invite.workspace.name,
    workspaceIcon: invite.workspace.icon,
    inviterName: invite.invitedBy.name,
    email: invite.email,
    role: invite.role,
    status: invite.status,
    expired: invite.status === 'pending' && invite.expiresAt < new Date(),
  };
};

// Shared by accept/decline — hash lookup, then the ONE check that stops
// "anyone with the link joins": the invite email must match the
// already-authenticated caller's own email.
const findInviteForResponse = async (rawToken, userEmail) => {
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const invite = await prisma.workspaceInvite.findUnique({ where: { tokenHash } });
  // Never reveal whether a token existed at all vs. existed but didn't match.
  if (!invite) throw AppError.notFound('This invite link is invalid');
  if (invite.email.toLowerCase() !== userEmail.toLowerCase()) {
    throw AppError.forbidden('This invite was sent to a different email address');
  }
  if (invite.status !== 'pending') throw AppError.conflict('This invite is no longer pending');
  if (invite.expiresAt < new Date()) throw AppError.conflict('This invite has expired');
  return invite;
};

exports.acceptInvite = async (rawToken, userId, userEmail) => {
  const invite = await findInviteForResponse(rawToken, userEmail);
  return prisma.$transaction(async (tx) => {
    const alreadyMember = await tx.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: invite.workspaceId, userId } },
    });
    if (!alreadyMember) {
      await tx.workspaceMember.create({ data: { workspaceId: invite.workspaceId, userId, role: invite.role } });
    }
    await tx.workspaceInvite.update({ where: { id: invite.id }, data: { status: 'accepted' } });
    return tx.workspace.findUnique({ where: { id: invite.workspaceId } });
  });
};

exports.declineInvite = async (rawToken, userId, userEmail) => {
  const invite = await findInviteForResponse(rawToken, userEmail);
  await prisma.workspaceInvite.update({ where: { id: invite.id }, data: { status: 'declined' } });
};

exports.updateMemberRole = async (workspaceId, memberUserId, role, requesterId) => {
  const ws = await assertOwner(workspaceId, requesterId);
  if (memberUserId === ws.ownerId) throw AppError.badRequest("Can't change the owner's role");
  if (role === 'owner') throw AppError.badRequest('Use ownership transfer to change the owner');
  const member = await prisma.workspaceMember.update({
    where: { workspaceId_userId: { workspaceId, userId: memberUserId } },
    data: { role },
    include: { user: { select: { id: true, name: true, email: true } } },
  });
  return member;
};

exports.removeMember = async (workspaceId, memberUserId, requesterId) => {
  const ws = await assertOwner(workspaceId, requesterId);
  if (memberUserId === ws.ownerId) throw AppError.badRequest("Can't remove the workspace owner");
  await prisma.workspaceMember.delete({ where: { workspaceId_userId: { workspaceId, userId: memberUserId } } });
};
