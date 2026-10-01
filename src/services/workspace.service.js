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

// Inline styles only — email clients don't load stylesheets. Kept to a
// single centered card rather than a full bulletproof-email table layout;
// this is a step up from the plain unstyled <p> tags password-reset still
// uses (out of scope here), not an attempt at pixel parity across
// every mail client.
const sendInviteEmail = async (invite, workspace, inviterName, rawToken) => {
  const acceptUrl = `${config.frontendUrl}/invite/${rawToken}`;
  const roleLabel = invite.role === 'viewer' ? 'a viewer' : 'an editor';
  await emailService.sendEmail({
    to: invite.email,
    subject: `You're invited to join ${workspace.name} on Motive`,
    html: `<div style="background:#F6F8F9;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <div style="max-width:480px;margin:0 auto;background:#FFFFFF;border-radius:12px;border:1px solid #DDE4E7;overflow:hidden;">
    <div style="background:linear-gradient(135deg,#0E4C5C,#1B7A8C);padding:24px 32px;">
      <span style="color:#FFFFFF;font-size:18px;font-weight:700;">Motive</span>
    </div>
    <div style="padding:32px;">
      <h1 style="margin:0 0 16px;font-size:20px;color:#0F1A20;">You're invited to ${workspace.name}</h1>
      <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#5E6E77;">
        <strong style="color:#0F1A20;">${inviterName}</strong> invited you to join <strong style="color:#0F1A20;">${workspace.name}</strong> on Motive as ${roleLabel}.
      </p>
      <a href="${acceptUrl}" style="display:inline-block;background:#1B7A8C;color:#FFFFFF;text-decoration:none;font-size:15px;font-weight:600;padding:12px 24px;border-radius:8px;">Accept invite</a>
      <p style="margin:24px 0 0;font-size:13px;color:#5E6E77;">This link expires in 7 days. If you weren't expecting this, you can safely ignore this email.</p>
    </div>
  </div>
</div>`,
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
// permission model builds on. `owner` and
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

// Returns { workspace, notification } — notification is the row for the
// inviter to be emitted over the socket (persist-in-service /
// emit-in-controller is the house pattern comment.service.js documents),
// null when the invite was already fulfilled (nothing new to tell anyone).
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

    const [workspace, accepter] = await Promise.all([
      tx.workspace.findUnique({ where: { id: invite.workspaceId } }),
      tx.user.findUnique({ where: { id: userId }, select: { name: true } }),
    ]);

    let notification = null;
    if (!alreadyMember) {
      notification = await tx.notification.create({
        data: {
          userId: invite.invitedById,
          title: 'New team member',
          message: `${accepter?.name || 'Someone'} joined ${workspace.name}`,
          type: 'invite_accepted',
        },
      });
    }
    return { workspace, notification };
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

// getRole derives 'owner' from Workspace.ownerId directly, not from a
// WorkspaceMember row (see getRole's own comment) — but the owner ALSO has
// an explicit member row with role 'owner', set at workspace creation. Both
// have to move together in one transaction or they desync, which is exactly
// the risk this was flagged against in the original roadmap.
exports.transferOwnership = async (workspaceId, newOwnerUserId, requesterId) => {
  const ws = await assertOwner(workspaceId, requesterId);
  if (newOwnerUserId === ws.ownerId) throw AppError.badRequest('Already the owner');
  const target = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: newOwnerUserId } },
  });
  if (!target) throw AppError.notFound('That user is not a member of this workspace');

  await prisma.$transaction([
    prisma.workspace.update({ where: { id: workspaceId }, data: { ownerId: newOwnerUserId } }),
    prisma.workspaceMember.update({
      where: { workspaceId_userId: { workspaceId, userId: requesterId } },
      data: { role: 'editor' },
    }),
    prisma.workspaceMember.update({
      where: { workspaceId_userId: { workspaceId, userId: newOwnerUserId } },
      data: { role: 'owner' },
    }),
  ]);
};

// Self-service, deliberately not a special case bolted onto removeMember —
// that function is owner-acting-on-someone-else (assertOwner-gated); this is
// self-acting, a different authorization shape, so it's its own function.
exports.leaveWorkspace = async (workspaceId, userId) => {
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { ownerId: true } });
  if (!ws) throw AppError.notFound('Workspace not found');
  if (ws.ownerId === userId) {
    throw AppError.badRequest('Transfer ownership before leaving a workspace you own');
  }
  const membership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
  });
  if (!membership) throw AppError.notFound('Not a member of this workspace');
  await prisma.workspaceMember.delete({ where: { workspaceId_userId: { workspaceId, userId } } });
};
