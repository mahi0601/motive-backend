// Client requests from the public status page: "can you also do X?". Like feedback
// this is an UNAUTHENTICATED WRITE, so it is opt-in per workspace, answers the same
// 404 as the read endpoint when unavailable, accepts only short plain text, drops
// honeypot hits silently and caps how many one workspace can receive in a day. The
// owner then accepts a request (which creates a task) or declines it. What the
// client sees afterwards is derived from the linked task (see publicList), so it
// follows the board without anyone updating it twice.
const crypto = require('crypto');
const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const audit = require('./audit.service');
const analytics = require('./analytics.service');
const workspaceService = require('./workspace.service');
const taskService = require('./task.service');
const { getPagination, paginated } = require('../utils/pagination');

const SCOPES = ['in_scope', 'extra'];
const STATES = ['received', 'accepted', 'declined'];
const MAX_NAME = 60;
const MAX_TITLE = 120;
const MAX_DETAILS = 1000;
const MAX_NOTE = 300;
const DAILY_CAP = 100;
const PUBLIC_LIMIT = 30;
const notAvailable = () => AppError.notFound('This status page is not available');

// Plain text only, as in feedback.service.js: strings, no control characters
// (newlines and tabs are kept), trimmed. Anything else is rejected, not coerced.
const isControl = (ch) => {
  const code = ch.charCodeAt(0);
  return (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127;
};
const cleanText = (v) => (typeof v === 'string' ? [...v].filter((ch) => !isControl(ch)).join('').trim() : null);

// An opaque handle for the public list, so the page never exposes a database id.
const refOf = (id) => crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 12);

// What the client sees. A declined request says so; an accepted one follows its task;
// an accepted request whose task has since been deleted is "closed", not "received".
const publicState = (r) => {
  if (r.state === 'declined') return 'declined';
  if (r.state === 'received') return 'received';
  if (!r.task) return 'closed';
  return { todo: 'planned', in_progress: 'in_progress', done: 'done' }[r.task.status] ?? 'planned';
};

exports.submit = async (rawToken, input = {}) => {
  const tokenHash = crypto.createHash('sha256').update(String(rawToken)).digest('hex');
  const ws = await prisma.workspace.findUnique({
    where: { shareTokenHash: tokenHash },
    select: { id: true, ownerId: true, name: true, statusAllowRequests: true },
  });
  if (!ws || !ws.statusAllowRequests) throw notAvailable();

  // Bots fill every field. A hit looks like success so it learns nothing, and
  // nothing is stored or sent.
  if (typeof input.website === 'string' && input.website.trim() !== '') return { stored: false };

  const name = cleanText(input.name);
  const title = cleanText(input.title);
  const details = input.details === undefined ? '' : cleanText(input.details);
  if (!name || name.length > MAX_NAME) throw new AppError(`Please enter your name (up to ${MAX_NAME} characters).`, 422);
  if (!title || title.length > MAX_TITLE) throw new AppError(`Please say what you need (up to ${MAX_TITLE} characters).`, 422);
  if (details === null || details.length > MAX_DETAILS) throw new AppError(`Details can be up to ${MAX_DETAILS} characters.`, 422);

  const today = await prisma.clientRequest.count({
    where: { workspaceId: ws.id, createdAt: { gt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
  });
  if (today >= DAILY_CAP) throw new AppError('This page cannot take more requests right now. Please try again tomorrow.', 429);

  const row = await prisma.clientRequest.create({ data: { workspaceId: ws.id, title, details, authorName: name } });

  const notification = await prisma.notification.create({
    data: {
      userId: ws.ownerId,
      title: `Client request on ${ws.name}`.slice(0, 80),
      message: `${name} asked: ${title}`.slice(0, 160),
      type: 'client_request',
    },
  });
  require('../sockets/socket.handler').emitNotification(ws.ownerId, notification);
  await audit.record({ type: 'client_request_received', workspaceId: ws.id });
  await analytics.track('request_received', { workspaceId: ws.id });
  return { stored: true, id: row.id };
};

// What the public page may show. Titles, a derived state, the scope tag and the
// owner's decline note: never the sender's name, details or any id.
exports.publicList = async (workspaceId) => {
  const rows = await prisma.clientRequest.findMany({
    where: { workspaceId },
    orderBy: { createdAt: 'desc' },
    take: PUBLIC_LIMIT,
    select: { id: true, title: true, state: true, scope: true, declineNote: true, createdAt: true, task: { select: { status: true } } },
  });
  return rows.map((r) => ({
    ref: refOf(r.id),
    title: r.title,
    state: publicState(r),
    scope: r.scope,
    declineNote: r.state === 'declined' ? r.declineNote : null,
    createdAt: r.createdAt,
  }));
};

// The monthly allowance, in calendar months (UTC, so it is the same moment for everyone).
// A request counts toward it when it was accepted this month and is not tagged extra work;
// extra work is counted on its own, so the client sees what was included and what was added.
// Computed on read from the rows, so re-tagging or deleting a request corrects it at once.
exports.allowanceUsage = async (workspaceId, limit, now = new Date()) => {
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const resetsOn = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const rows = await prisma.clientRequest.groupBy({
    by: ['scope'],
    where: { workspaceId, state: 'accepted', decidedAt: { gte: since } },
    _count: { _all: true },
  });
  const extra = rows.filter((r) => r.scope === 'extra').reduce((n, r) => n + r._count._all, 0);
  const used = rows.filter((r) => r.scope !== 'extra').reduce((n, r) => n + r._count._all, 0);
  return { limit, used, extra, resetsOn };
};

exports.list = async (workspaceId, requesterId, query = {}) => {
  await workspaceService.assertOwner(workspaceId, requesterId);
  if (query.state !== undefined && !STATES.includes(query.state)) throw new AppError('Unknown state.', 422);
  const where = { workspaceId, ...(query.state ? { state: query.state } : {}) };
  const pagination = getPagination(query, { defaultLimit: 20, maxLimit: 100 });
  const owner = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { statusRequestAllowance: true } });
  const [items, total, unread, allowance] = await Promise.all([
    prisma.clientRequest.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: pagination.skip,
      take: pagination.limit,
      include: { task: { select: { id: true, status: true } } },
    }),
    prisma.clientRequest.count({ where }),
    prisma.clientRequest.count({ where: { workspaceId, readAt: null } }),
    owner?.statusRequestAllowance ? exports.allowanceUsage(workspaceId, owner.statusRequestAllowance) : Promise.resolve(null),
  ]);
  return { ...paginated(items, total, pagination), unread, allowance };
};

const findOwned = async (workspaceId, requestId) => {
  const row = await prisma.clientRequest.findFirst({ where: { id: requestId, workspaceId } });
  if (!row) throw AppError.notFound('Request not found');
  return row;
};

const checkScope = (scope) => {
  if (scope !== undefined && scope !== null && !SCOPES.includes(scope)) throw new AppError('Choose in scope or extra work.', 422);
};

// Turn a request into a task on the owner's board. The task goes through the normal
// create path (validation, position, activity log, analytics). The claim on the row is
// made first, atomically, so two quick clicks cannot make two tasks.
exports.accept = async (workspaceId, requestId, requesterId, { scope } = {}) => {
  await workspaceService.assertOwner(workspaceId, requesterId);
  checkScope(scope);
  const row = await findOwned(workspaceId, requestId);

  const claimed = await prisma.clientRequest.updateMany({
    where: { id: row.id, state: 'received' },
    data: { state: 'accepted', scope: scope ?? null, decidedAt: new Date(), readAt: row.readAt ?? new Date() },
  });
  if (claimed.count === 0) throw AppError.conflict('This request has already been decided.');

  try {
    const task = await taskService.create(
      { title: row.title, description: row.details || undefined, workspaceId, status: 'todo', assigneeId: requesterId },
      requesterId
    );
    await prisma.clientRequest.update({ where: { id: row.id }, data: { taskId: task.id } });
    await audit.record({ type: 'client_request_accepted', actorId: requesterId, workspaceId, meta: { scope: scope ?? 'none' } });
    return { request: await prisma.clientRequest.findUnique({ where: { id: row.id } }), task };
  } catch (err) {
    // No task was made, so put the request back rather than leave it half-decided.
    await prisma.clientRequest.updateMany({
      where: { id: row.id, taskId: null },
      data: { state: 'received', scope: null, decidedAt: null },
    });
    throw err;
  }
};

exports.decline = async (workspaceId, requestId, requesterId, { note } = {}) => {
  await workspaceService.assertOwner(workspaceId, requesterId);
  const cleaned = note === undefined || note === null ? null : cleanText(note);
  if (note !== undefined && note !== null && (cleaned === null || cleaned.length > MAX_NOTE)) {
    throw new AppError(`The note can be up to ${MAX_NOTE} characters.`, 422);
  }
  const row = await findOwned(workspaceId, requestId);
  const done = await prisma.clientRequest.updateMany({
    where: { id: row.id, state: 'received' },
    data: { state: 'declined', declineNote: cleaned || null, decidedAt: new Date(), readAt: row.readAt ?? new Date() },
  });
  if (done.count === 0) throw AppError.conflict('This request has already been decided.');
  await audit.record({ type: 'client_request_declined', actorId: requesterId, workspaceId });
  return prisma.clientRequest.findUnique({ where: { id: row.id } });
};

// Change the scope tag (any time) and/or mark it read.
exports.update = async (workspaceId, requestId, requesterId, { scope, read } = {}) => {
  await workspaceService.assertOwner(workspaceId, requesterId);
  checkScope(scope);
  const row = await findOwned(workspaceId, requestId);
  const data = {};
  if (scope !== undefined) data.scope = scope;
  if (read === true && !row.readAt) data.readAt = new Date();
  if (Object.keys(data).length === 0) return row;
  return prisma.clientRequest.update({ where: { id: row.id }, data });
};

exports.remove = async (workspaceId, requestId, requesterId) => {
  await workspaceService.assertOwner(workspaceId, requesterId);
  // Scoped by workspace, so an id from another workspace does nothing. The task, if
  // one was made, stays: it is the owner's work.
  const done = await prisma.clientRequest.deleteMany({ where: { id: requestId, workspaceId } });
  if (done.count === 0) throw AppError.notFound('Request not found');
};

// For the Clients overview: requests nobody has looked at yet, per workspace.
exports.unreadCounts = async (workspaceIds) => {
  if (!workspaceIds.length) return new Map();
  const rows = await prisma.clientRequest.groupBy({
    by: ['workspaceId'],
    where: { workspaceId: { in: workspaceIds }, state: 'received', readAt: null },
    _count: { _all: true },
  });
  return new Map(rows.map((r) => [r.workspaceId, r._count._all]));
};
