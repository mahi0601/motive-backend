// Client feedback from the public status page. The one unauthenticated WRITE in
// the app, so everything here is defensive: it only works when the owner has
// turned it on, answers the same 404 as the read endpoint when it is
// unavailable (unknown, rotated, disabled and "feedback off" look identical),
// accepts only short plain text, drops honeypot hits silently, and caps how
// much one workspace can receive in a day. The sender is whoever holds the link
// and their name is not verified.
const crypto = require('crypto');
const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const audit = require('./audit.service');
const workspaceService = require('./workspace.service');
const { getPagination, paginated } = require('../utils/pagination');

const KINDS = ['comment', 'approve', 'changes'];
const MAX_NAME = 60;
const MAX_MESSAGE = 1000;
const DAILY_CAP = 200;
const PREVIEW_CHARS = 100;
const notAvailable = () => AppError.notFound('This status page is not available');

// Plain text only: strings, no control characters (newlines and tabs are kept),
// trimmed. Anything else is rejected rather than coerced.
const isControl = (ch) => {
  const code = ch.charCodeAt(0);
  return (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127;
};
const cleanText = (v) => (typeof v === 'string' ? [...v].filter((ch) => !isControl(ch)).join('').trim() : null);

const KIND_LABEL = {
  approve: 'approved the milestone',
  changes: 'requested changes',
  comment: 'left a comment',
};

exports.submit = async (rawToken, input = {}) => {
  const tokenHash = crypto.createHash('sha256').update(String(rawToken)).digest('hex');
  const ws = await prisma.workspace.findUnique({
    where: { shareTokenHash: tokenHash },
    select: { id: true, ownerId: true, name: true, milestoneTitle: true, statusAllowFeedback: true },
  });
  if (!ws || !ws.statusAllowFeedback) throw notAvailable();

  // Bots fill every field. A hit looks like success so it learns nothing, and
  // nothing is stored or sent.
  if (typeof input.website === 'string' && input.website.trim() !== '') return { stored: false };

  const kind = input.kind;
  const name = cleanText(input.name);
  const message = input.message === undefined ? '' : cleanText(input.message);
  if (!KINDS.includes(kind)) throw new AppError('Choose approve, request changes or comment.', 422);
  if (!name || name.length > MAX_NAME) throw new AppError(`Please enter your name (up to ${MAX_NAME} characters).`, 422);
  if (message === null || message.length > MAX_MESSAGE) throw new AppError(`Messages can be up to ${MAX_MESSAGE} characters.`, 422);
  if (kind !== 'approve' && !message) throw new AppError('Please write a message.', 422);

  const today = await prisma.clientFeedback.count({
    where: { workspaceId: ws.id, createdAt: { gt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
  });
  if (today >= DAILY_CAP) throw new AppError('This page cannot take more feedback right now. Please try again tomorrow.', 429);

  const row = await prisma.clientFeedback.create({
    data: { workspaceId: ws.id, kind, authorName: name, message, milestoneTitle: ws.milestoneTitle },
  });

  // Tell the owner. The preview is short and is only ever shown as text.
  const preview = message ? `: ${message.slice(0, PREVIEW_CHARS)}${message.length > PREVIEW_CHARS ? '…' : ''}` : '';
  const notification = await prisma.notification.create({
    data: {
      userId: ws.ownerId,
      title: `Client feedback on ${ws.name}`.slice(0, 80),
      message: `${name} ${KIND_LABEL[kind]}${preview}`.slice(0, 160),
      type: 'client_feedback',
    },
  });
  require('../sockets/socket.handler').emitNotification(ws.ownerId, notification);
  await audit.record({ type: 'client_feedback_received', workspaceId: ws.id, meta: { kind } });
  return { stored: true, id: row.id };
};

exports.list = async (workspaceId, requesterId, query = {}) => {
  await workspaceService.assertOwner(workspaceId, requesterId);
  const pagination = getPagination(query, { defaultLimit: 20, maxLimit: 100 });
  const [items, total, unread] = await Promise.all([
    prisma.clientFeedback.findMany({ where: { workspaceId }, orderBy: { createdAt: 'desc' }, skip: pagination.skip, take: pagination.limit }),
    prisma.clientFeedback.count({ where: { workspaceId } }),
    prisma.clientFeedback.count({ where: { workspaceId, readAt: null } }),
  ]);
  return { ...paginated(items, total, pagination), unread };
};

exports.markRead = async (workspaceId, feedbackId, requesterId) => {
  await workspaceService.assertOwner(workspaceId, requesterId);
  const done = await prisma.clientFeedback.updateMany({ where: { id: feedbackId, workspaceId, readAt: null }, data: { readAt: new Date() } });
  if (done.count === 0 && !(await prisma.clientFeedback.findFirst({ where: { id: feedbackId, workspaceId } }))) {
    throw AppError.notFound('Feedback not found');
  }
};

exports.remove = async (workspaceId, feedbackId, requesterId) => {
  await workspaceService.assertOwner(workspaceId, requesterId);
  // Scoped by workspace, so an id from another workspace does nothing.
  const done = await prisma.clientFeedback.deleteMany({ where: { id: feedbackId, workspaceId } });
  if (done.count === 0) throw AppError.notFound('Feedback not found');
};
