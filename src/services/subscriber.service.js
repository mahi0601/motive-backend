// The people who get a client's weekly update email. The owner adds them (the client never signs
// up); each gets a personal link that opens the status page and also unsubscribes them. Removing
// the row, or switching the status link off, ends that access.
const crypto = require('crypto');
const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const { limitsFor, PLAN_NAMES, effectivePlan } = require('../utils/plans');
const { sha256, subscriberToken } = require('../utils/shareToken');
const workspaceService = require('./workspace.service');
const audit = require('./audit.service');

const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/;
const MAX_EMAIL = 254;
const MAX_NAME = 80;

const safe = (s) => ({ id: s.id, email: s.email, name: s.name, unsubscribed: Boolean(s.unsubscribedAt), createdAt: s.createdAt });

exports.list = async (workspaceId, requesterId) => {
  await workspaceService.assertOwner(workspaceId, requesterId);
  const rows = await prisma.statusSubscriber.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } });
  const owner = await prisma.user.findUnique({ where: { id: requesterId }, select: { isPro: true, proLifetime: true, plan: true } });
  return { items: rows.map(safe), limit: limitsFor(owner).subscribers };
};

exports.add = async (workspaceId, requesterId, input = {}) => {
  await workspaceService.assertOwner(workspaceId, requesterId);
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  if (!email || email.length > MAX_EMAIL || !EMAIL_RE.test(email)) throw new AppError('Enter a valid email address.', 422);
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, MAX_NAME) || null : null;

  const owner = await prisma.user.findUnique({ where: { id: requesterId }, select: { isPro: true, proLifetime: true, plan: true } });
  const limit = limitsFor(owner).subscribers;
  const existing = await prisma.statusSubscriber.findUnique({ where: { workspaceId_email: { workspaceId, email } } });
  if (existing) {
    // Adding someone who unsubscribed is the owner's call: it re-subscribes them.
    if (!existing.unsubscribedAt) throw new AppError('That email is already on the list.', 409);
    const back = await prisma.statusSubscriber.update({ where: { id: existing.id }, data: { unsubscribedAt: null, ...(name ? { name } : {}) } });
    return safe(back);
  }
  const count = await prisma.statusSubscriber.count({ where: { workspaceId } });
  if (count >= limit) {
    const plan = effectivePlan(owner);
    throw AppError.paymentRequired(`${PLAN_NAMES[plan]} includes ${limit} ${limit === 1 ? 'person' : 'people'} per client for the weekly email.`);
  }
  const id = `sub${crypto.randomBytes(12).toString('hex')}`;
  const row = await prisma.statusSubscriber.create({ data: { id, workspaceId, email, name, tokenHash: sha256(subscriberToken(id)) } });
  await audit.record({ type: 'subscriber_added', actorId: requesterId, workspaceId });
  return safe(row);
};

exports.remove = async (workspaceId, subscriberId, requesterId) => {
  await workspaceService.assertOwner(workspaceId, requesterId);
  const done = await prisma.statusSubscriber.deleteMany({ where: { id: subscriberId, workspaceId } });
  if (!done.count) throw AppError.notFound('Subscriber not found');
  await audit.record({ type: 'subscriber_removed', actorId: requesterId, workspaceId });
};

// Public: the personal link is the credential. Unknown tokens answer the same 404.
const findByToken = async (rawToken) => {
  const row = await prisma.statusSubscriber.findUnique({
    where: { tokenHash: sha256(rawToken) },
    select: { id: true, unsubscribedAt: true, workspace: { select: { name: true } } },
  });
  if (!row) throw AppError.notFound('This link is not available');
  return row;
};

exports.unsubscribeInfo = async (rawToken) => {
  const row = await findByToken(rawToken);
  return { workspaceName: row.workspace.name, unsubscribed: Boolean(row.unsubscribedAt) };
};

exports.unsubscribe = async (rawToken) => {
  const row = await findByToken(rawToken);
  if (!row.unsubscribedAt) await prisma.statusSubscriber.update({ where: { id: row.id }, data: { unsubscribedAt: new Date() } });
  return { workspaceName: row.workspace.name, unsubscribed: true };
};
