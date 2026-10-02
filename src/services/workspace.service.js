const crypto = require('crypto');
const prisma = require('../config/prisma');
const audit = require('./audit.service');
const analytics = require('./analytics.service');
const AppError = require('../utils/AppError');
const emailService = require('./email.service');
const config = require('../config/env');
const { PLAN_LIMITS, PLAN_NAMES, NEXT_PLAN, effectivePlan } = require('../utils/plans');

// Team size per workspace and the number of active clients depend on the owner's
// plan — see utils/plans.js (Free: 2 members, 1 client; Studio: 5 and 10; Agency:
// 15 and unlimited). The limits apply when something is ADDED, so an account that
// is over a limit (an older free account, a lapsed subscriber) keeps what it has.
const DAILY_INVITE_LIMIT = 20;

// "Upgrade to X" wording shared by the limit errors below.
const upgradeHint = (plan) => {
  const next = NEXT_PLAN[plan];
  return next ? ` — upgrade to Clientglass ${PLAN_NAMES[next]} for more.` : '.';
};
const memberLimitMessage = (plan) =>
  `${PLAN_NAMES[plan]} workspaces are limited to ${PLAN_LIMITS[plan].members} members${upgradeHint(plan)}`;

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
const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

// The reversed (white-on-transparent) logo served by the frontend — generated
// by `npm run brand` in the frontend repo at 2× (346×80), shown here at half
// size so it stays sharp on retina screens. Email clients don't render SVG, hence
// a PNG, and it must be an absolute URL, hence frontendUrl. The deployed
// frontend has to be live for it to show; until then (or if a client blocks
// images) the `alt` text below keeps "Clientglass" visible in the same white bold.
const EMAIL_LOGO_WIDTH = 173;
const EMAIL_LOGO_HEIGHT = 40;

const sendInviteEmail = async (invite, workspace, inviterName, rawToken) => {
  const acceptUrl = `${config.frontendUrl}/invite/${rawToken}`;
  const logoUrl = `${config.frontendUrl}/brand/logo-email.png`;
  // User-controlled strings go into HTML below — escape them so a workspace
  // or inviter name can't inject markup into an email sent from Clientglass's address.
  const safeWorkspaceName = escapeHtml(workspace.name);
  const safeInviterName = escapeHtml(inviterName);
  const roleLabel = invite.role === 'viewer' ? 'a viewer' : 'an editor';
  await emailService.sendEmail({
    to: invite.email,
    subject: `You're invited to join ${workspace.name} on Clientglass`,
    html: `<div style="background:#F6F8F9;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <div style="max-width:480px;margin:0 auto;background:#FFFFFF;border-radius:12px;border:1px solid #DDE4E7;overflow:hidden;">
    <div style="background-color:#0E4C5C;background-image:linear-gradient(135deg,#0E4C5C,#1B7A8C);padding:24px 32px;">
      <img src="${logoUrl}" alt="Clientglass" width="${EMAIL_LOGO_WIDTH}" height="${EMAIL_LOGO_HEIGHT}" style="display:block;border:0;outline:none;height:${EMAIL_LOGO_HEIGHT}px;width:auto;color:#FFFFFF;font-size:18px;font-weight:700;line-height:${EMAIL_LOGO_HEIGHT}px;">
    </div>
    <div style="padding:32px;">
      <h1 style="margin:0 0 16px;font-size:20px;color:#0F1A20;">You're invited to ${safeWorkspaceName}</h1>
      <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#5E6E77;">
        <strong style="color:#0F1A20;">${safeInviterName}</strong> invited you to join <strong style="color:#0F1A20;">${safeWorkspaceName}</strong> on Clientglass as ${roleLabel}.
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

// Allowlist the writable fields — spreading the raw request body here would
// let a caller pass nested relation writes (e.g. `tasks: { connect: [...] }`)
// and pull other users' records into their own workspace.
exports.create = (data, userId) =>
  prisma.workspace.create({
    data: {
      name: data?.name,
      icon: data?.icon,
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

// The access rule every owned resource shares — Task (`userId`), Page
// (`ownerId`) and, through its page, Block: the creator has access to a personal item (no workspace);
// anyone else needs a workspace role sufficient for `need`. Throws a 404
// (never a 403) with `notFoundMessage`, so a non-member can't tell a resource
// they can't reach from one that doesn't exist. `resource` is any row with
// `{ ownerId | userId, workspaceId }`.
exports.assertResourceAccess = async (resource, userId, need, notFoundMessage) => {
  const creatorId = 'ownerId' in resource ? resource.ownerId : resource.userId;
  // Personal items (no workspace) always belong to their creator. In a
  // workspace, authorship is not access: someone removed from it must not keep
  // reaching what they created there, so a creator is checked like anyone else.
  if (creatorId === userId && !resource.workspaceId) return;
  if (!(await exports.canAccess(resource.workspaceId, userId, need))) {
    throw AppError.notFound(notFoundMessage);
  }
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

  const requester = await prisma.user.findUnique({
    where: { id: requesterId },
    select: { name: true, isPro: true, proLifetime: true, plan: true, emailVerifiedAt: true },
  });
  // Invites send email from Clientglass's address to arbitrary people, so they are
  // the thing a throwaway account would abuse; require a proven address first.
  if (!requester.emailVerifiedAt) {
    throw AppError.forbidden('Verify your email address before inviting people — check your inbox for the confirmation link.');
  }
  const sentToday = await prisma.workspaceInvite.count({
    where: { invitedById: requesterId, updatedAt: { gt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
  });
  if (sentToday >= DAILY_INVITE_LIMIT) {
    throw new AppError('You have reached the daily invite limit — try again tomorrow.', 429);
  }
  {
    const plan = effectivePlan(requester);
    // Pending invites hold a seat too, or a workspace could queue up any
    // number of invites and only hit the limit as they are accepted.
    const [memberCount, pendingElsewhere] = await Promise.all([
      prisma.workspaceMember.count({ where: { workspaceId } }),
      prisma.workspaceInvite.count({
        where: { workspaceId, status: 'pending', expiresAt: { gt: new Date() }, email: { not: normalizedEmail } },
      }),
    ]);
    if (memberCount + pendingElsewhere >= PLAN_LIMITS[plan].members) {
      throw AppError.paymentRequired(memberLimitMessage(plan));
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
  await audit.record({ type: 'invite_created', actorId: requesterId, workspaceId, meta: { role } });
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

  // The seat limit is checked again here, not only when the invite was sent: the
  // workspace may have filled up, or the owner's plan may have changed, since.
  const [inviteWorkspace, existingMembership] = await Promise.all([
    prisma.workspace.findUnique({
      where: { id: invite.workspaceId },
      select: { owner: { select: { isPro: true, proLifetime: true, plan: true } } },
    }),
    prisma.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId: invite.workspaceId, userId } } }),
  ]);
  if (!existingMembership && inviteWorkspace) {
    const plan = effectivePlan(inviteWorkspace.owner);
    const memberCount = await prisma.workspaceMember.count({ where: { workspaceId: invite.workspaceId } });
    if (memberCount >= PLAN_LIMITS[plan].members) {
      throw AppError.paymentRequired(
        NEXT_PLAN[plan]
          ? `This workspace has reached its member limit — ask its owner to upgrade to Clientglass ${PLAN_NAMES[NEXT_PLAN[plan]]}.`
          : 'This workspace has reached its member limit.'
      );
    }
  }

  const result = await prisma.$transaction(async (tx) => {
    const alreadyMember = await tx.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: invite.workspaceId, userId } },
    });
    if (!alreadyMember) {
      await tx.workspaceMember.create({ data: { workspaceId: invite.workspaceId, userId, role: invite.role } });
    }
    await tx.workspaceInvite.update({ where: { id: invite.id }, data: { status: 'accepted' } });
    // The token only went to this address, so holding it proves the address.
    await tx.user.updateMany({ where: { id: userId, emailVerifiedAt: null }, data: { emailVerifiedAt: new Date() } });

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
  await audit.record({ type: 'invite_accepted', actorId: userId, workspaceId: invite.workspaceId, meta: { role: invite.role } });
  return result;
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
  await audit.record({ type: 'role_changed', actorId: requesterId, targetUserId: memberUserId, workspaceId, meta: { role } });
  await require('../sockets/revoke').recheckUserAccess(memberUserId);
  return member;
};

exports.removeMember = async (workspaceId, memberUserId, requesterId) => {
  const ws = await assertOwner(workspaceId, requesterId);
  if (memberUserId === ws.ownerId) throw AppError.badRequest("Can't remove the workspace owner");
  await prisma.workspaceMember.delete({ where: { workspaceId_userId: { workspaceId, userId: memberUserId } } });
  await audit.record({ type: 'member_removed', actorId: requesterId, targetUserId: memberUserId, workspaceId });
  await require('../sockets/revoke').recheckUserAccess(memberUserId);
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
  await audit.record({ type: 'ownership_transferred', actorId: requesterId, targetUserId: newOwnerUserId, workspaceId });
  await require('../sockets/revoke').recheckUserAccess(requesterId);
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
  await audit.record({ type: 'member_left', actorId: userId, targetUserId: userId, workspaceId });
  await require('../sockets/revoke').recheckUserAccess(userId);
};

// ── Public client status page ───────────────────────────
// One share link per workspace. Same token pattern as invites (newInviteToken:
// random raw token, only its sha256 stored) so a database read can't reveal a
// working link, and the raw token is only ever shown once, here, to the owner.
//
// Calling enableShare again rotates the link — the old one stops working
// immediately, which is the "regenerate" action in the UI.
//
// Turning on a link makes the workspace an ACTIVE CLIENT, which is what plans
// are priced by. Regenerating the link of a page that is already live adds no
// client, so it is never refused (an account over its limit can still do it).
exports.enableShare = async (workspaceId, requesterId) => {
  await assertOwner(workspaceId, requesterId);
  const current = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { shareEnabledAt: true } });
  if (!current?.shareEnabledAt) {
    const owner = await prisma.user.findUnique({
      where: { id: requesterId },
      select: { isPro: true, proLifetime: true, plan: true },
    });
    const plan = effectivePlan(owner);
    const limit = PLAN_LIMITS[plan].clients;
    if (Number.isFinite(limit)) {
      const live = await prisma.workspace.count({
        where: { ownerId: requesterId, shareEnabledAt: { not: null }, id: { not: workspaceId } },
      });
      if (live >= limit) {
        throw AppError.paymentRequired(
          `${PLAN_NAMES[plan]} includes ${limit} active client ${limit === 1 ? 'page' : 'pages'}${upgradeHint(plan)}`
        );
      }
    }
  }
  const { raw, tokenHash } = newInviteToken();
  const ws = await prisma.workspace.update({
    where: { id: workspaceId },
    data: { shareTokenHash: tokenHash, shareEnabledAt: new Date() },
    select: { shareEnabledAt: true },
  });
  await audit.record({ type: 'share_link_enabled', actorId: requesterId, workspaceId });
  await analytics.track('status_link_created', { userId: requesterId, workspaceId });
  return { token: raw, shareEnabledAt: ws.shareEnabledAt };
};

exports.disableShare = async (workspaceId, requesterId) => {
  await assertOwner(workspaceId, requesterId);
  await prisma.workspace.update({
    where: { id: workspaceId },
    data: { shareTokenHash: null, shareEnabledAt: null },
  });
  await audit.record({ type: 'share_link_disabled', actorId: requesterId, workspaceId });
};

// Owner-only edit of what the public status page says about the project. See
// the Workspace model for what each field is. Only fields present in `input`
// are touched; '' (or null for the date) clears one. Hiding the "Powered by
// Clientglass" footer needs Pro: refused here for a free owner, and the public read
// below re-checks it so a lapsed Pro brings the footer back without a write.
exports.assertOwner = (...args) => assertOwner(...args);

exports.updateStatusPage = async (workspaceId, requesterId, input = {}) => {
  await assertOwner(workspaceId, requesterId);

  const text = (v) => (v === undefined ? undefined : v === null || v === '' ? null : String(v).trim() || null);
  const data = {
    statusHeadline: text(input.headline),
    statusSummary: text(input.summary),
    milestoneTitle: text(input.milestoneTitle),
    milestoneDate:
      input.milestoneDate === undefined ? undefined : input.milestoneDate ? new Date(input.milestoneDate) : null,
    statusAccent: input.accent,
    statusHideBranding: input.hideBranding,
    statusAllowFeedback: input.allowFeedback,
  };
  for (const k of Object.keys(data)) if (data[k] === undefined) delete data[k];

  // A new milestone name or date starts a clean slate for approvals: bump the
  // version approvals are tied to. Saving the same values again does not.
  if ('milestoneTitle' in data || 'milestoneDate' in data) {
    const current = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { milestoneTitle: true, milestoneDate: true } });
    const titleChanged = 'milestoneTitle' in data && data.milestoneTitle !== current.milestoneTitle;
    const dateChanged = 'milestoneDate' in data && (data.milestoneDate?.getTime() ?? null) !== (current.milestoneDate?.getTime() ?? null);
    if (titleChanged || dateChanged) data.milestoneVersion = { increment: 1 };
  }

  if (data.statusHideBranding === true) {
    const owner = await prisma.user.findUnique({ where: { id: requesterId }, select: { isPro: true } });
    if (!owner?.isPro) {
      throw AppError.paymentRequired('Hiding "Powered by Clientglass" is part of Clientglass Pro.');
    }
  }

  const ws = await prisma.workspace.update({
    where: { id: workspaceId },
    data,
    select: { statusHeadline: true, statusSummary: true, milestoneTitle: true, milestoneDate: true, statusAccent: true, statusHideBranding: true, statusAllowFeedback: true },
  });
  // Which fields changed, never what they say.
  await audit.record({ type: 'status_page_updated', actorId: requesterId, workspaceId, meta: { fields: Object.keys(data).join(',') } });
  return ws;
};

const STATUS_PAGE_TASK_LIMIT = 200;

// Everything the public page may see, and nothing else: an allowlist built
// field-by-field (like safeInviteFields), never a spread of a task row. No
// ids, no assignees or other people, no descriptions, no comments or files —
// just a title, a status and dates. The owner is warned in the UI that task
// titles become public.
exports.getStatusByToken = async (rawToken, { visitor, preview = false } = {}) => {
  const tokenHash = crypto.createHash('sha256').update(String(rawToken)).digest('hex');
  const ws = await prisma.workspace.findUnique({
    where: { shareTokenHash: tokenHash },
    select: {
      id: true,
      name: true,
      icon: true,
      statusHeadline: true,
      statusSummary: true,
      milestoneTitle: true,
      milestoneDate: true,
      statusAccent: true,
      statusHideBranding: true,
      statusAllowFeedback: true,
      milestoneVersion: true,
      owner: { select: { isPro: true } },
    },
  });
  // Unknown, rotated and disabled links are indistinguishable on purpose.
  if (!ws) throw AppError.notFound('This status page is not available');

  // Count a view only for a link that works, and not for the owner's own preview.
  // Fire and forget: never slows the page.
  if (!preview) analytics.track('status_page_viewed', { workspaceId: ws.id, visitor });

  // Approved = the latest approve-or-request-changes on THIS version of the
  // milestone was an approval. Only the date is exposed: the sender's typed name
  // is unverified text and this page is public.
  let approvedAt = null;
  if (ws.milestoneTitle) {
    const latest = await prisma.clientFeedback.findFirst({
      where: { workspaceId: ws.id, milestoneVersion: ws.milestoneVersion, kind: { in: ['approve', 'changes'] } },
      orderBy: { createdAt: 'desc' },
      select: { kind: true, createdAt: true },
    });
    if (latest?.kind === 'approve') approvedAt = latest.createdAt;
  }

  const [counts, tasks] = await Promise.all([
    prisma.task.groupBy({ by: ['status'], where: { workspaceId: ws.id }, _count: { _all: true } }),
    prisma.task.findMany({
      where: { workspaceId: ws.id },
      select: { title: true, status: true, dueDate: true, completedAt: true },
      // Enum order is todo → in_progress → done; undated tasks sort last.
      orderBy: [{ status: 'asc' }, { dueDate: { sort: 'asc', nulls: 'last' } }],
      take: STATUS_PAGE_TASK_LIMIT,
    }),
  ]);

  const summary = { todo: 0, in_progress: 0, done: 0 };
  for (const row of counts) summary[row.status] = row._count._all;
  const total = summary.todo + summary.in_progress + summary.done;
  const percent = total === 0 ? 0 : Math.round((summary.done / total) * 100);

  return {
    workspace: { name: ws.name, icon: ws.icon },
    page: {
      headline: ws.statusHeadline,
      summary: ws.statusSummary,
      milestone: ws.milestoneTitle ? { title: ws.milestoneTitle, date: ws.milestoneDate, approvedAt } : null,
      accent: ws.statusAccent,
      // Pro-only, re-checked on every read so a lapsed plan shows the footer again.
      hideBranding: ws.statusHideBranding && ws.owner.isPro,
      allowFeedback: ws.statusAllowFeedback,
    },
    summary: { ...summary, total, percent },
    tasks: tasks.map((t) => ({
      title: t.title,
      status: t.status,
      dueDate: t.dueDate,
      completedAt: t.completedAt,
    })),
    truncated: total > tasks.length,
  };
};
