const prisma = require('../config/prisma');
const AppError = require('../utils/AppError');
const activityLog = require('./activityLog.service');
const workspaceService = require('./workspace.service');

// Paginated, indexed read — scales to large task counts per user.
//
// `workspaceId` is opt-in and additive (see PLAN "Total scope" §A): omitted,
// this is byte-for-byte the same `WHERE userId = ?` every existing solo
// caller already gets — that's deliberate, it's what "regression on the
// existing solo product" in the plan's verification section means. Only
// when a caller explicitly asks for a specific workspace's tasks (a shared
// client/team board) does this become workspace-scoped instead of
// user-scoped, and only after confirming the caller can actually read that
// workspace.
exports.getAll = async (userId, { skip, limit, workspaceId } = {}) => {
  let where;
  if (workspaceId) {
    if (!(await workspaceService.canAccess(workspaceId, userId, 'read'))) {
      throw AppError.notFound('Workspace not found');
    }
    where = { workspaceId };
  } else {
    where = { userId };
  }
  const [items, total] = await Promise.all([
    prisma.task.findMany({ where, orderBy: { position: 'asc' }, skip, take: limit }),
    prisma.task.count({ where }),
  ]);
  return { items, total };
};

// Shared by comment/subtask/file services (and upload.controller.js) — each
// used to re-implement this same "does this task belong to this user" check
// with a slightly different shape. `title` is included since the comment
// service needs it for notification text; callers that only need existence
// can just ignore it.
// Was `assertOwner` (owner-only, full stop) — comment/subtask/file services
// (see comment.service.js/subtask.service.js/file.service.js) all built on
// that, from before a task could belong to a shared workspace at all. Once
// Task gained workspaceId (PLAN "Total scope" §A), that became a stale
// assumption baked into three other services, not just this one — an
// editor who can now edit a shared task still couldn't comment on it, add a
// subtask, or attach a file to it. Same owner-or-role check as everywhere
// else now; `need` defaults to 'read' since commenting/viewing on a shared
// task is reasonable even for a viewer (e.g. a client leaving feedback) —
// callers that mutate task content (subtasks, file uploads) pass 'write'.
exports.assertAccess = async (taskId, userId, need = 'read') => {
  const task = await prisma.task.findUnique({ where: { id: taskId }, select: { id: true, title: true, userId: true, workspaceId: true } });
  if (!task) throw AppError.notFound('Task not found');
  const isOwner = task.userId === userId;
  if (!isOwner && !(await workspaceService.canAccess(task.workspaceId, userId, need))) {
    throw AppError.notFound('Task not found');
  }
  return task;
};

// Title search, for the command palette — mirrors page.service.js's search.
exports.search = async (term, userId) => {
  if (!term || !term.trim()) return [];
  return prisma.task.findMany({
    where: { userId, title: { contains: term.trim(), mode: 'insensitive' } },
    orderBy: { position: 'asc' },
    take: 20,
  });
};

const WRITABLE_FIELDS = ['title', 'description', 'priority', 'status', 'category', 'dueDate', 'tags', 'recurrence'];

function nextOccurrence(from, frequency) {
  const d = new Date(from);
  if (frequency === 'daily') d.setDate(d.getDate() + 1);
  else if (frequency === 'weekly') d.setDate(d.getDate() + 7);
  else if (frequency === 'monthly') d.setMonth(d.getMonth() + 1);
  return d;
}

// Completing a recurring task creates its next occurrence immediately,
// rather than a scheduled job generating instances ahead of time — simpler,
// and naturally idempotent (exactly one next-occurrence per completion, no
// risk of a cron run double-generating). Carries over everything except the
// completion state and due date, which moves forward by one interval (from
// the old due date if there was one, else from today).
// Deliberately uses `task.userId` (the original task's owner) for the new
// occurrence, never the caller who happened to be the one to complete it —
// now that a workspace editor can complete a teammate's recurring task
// (see `update` below), those are no longer always the same person, and the
// next occurrence must stay owned by whoever the task actually belongs to.
async function spawnNextOccurrence(task) {
  const dueDate = nextOccurrence(task.dueDate || new Date(), task.recurrence);
  await prisma.$transaction(
    async (tx) => {
      const count = await tx.task.count({ where: { userId: task.userId } });
      return tx.task.create({
        data: {
          title: task.title,
          description: task.description,
          priority: task.priority,
          category: task.category,
          tags: task.tags,
          recurrence: task.recurrence,
          dueDate,
          userId: task.userId,
          // Carries the workspace/assignee forward too — a recurring task
          // in a shared workspace should keep recurring there, not silently
          // drop back to no workspace on its next occurrence.
          workspaceId: task.workspaceId,
          assigneeId: task.assigneeId,
          position: count,
        },
      });
    },
    { isolationLevel: 'Serializable' }
  );
}

// `completedAt` isn't client-writable — it's derived from the `status`
// transition so the statistics service has a trustworthy "when" for a
// completion, independent of `updatedAt` (which changes on any edit).
// Needs the task's *previous* status: re-sending `status: 'done'` on a task
// that's already done (e.g. bulk-complete selecting a mixed set of done and
// not-done tasks) must NOT re-stamp `completedAt` to "now" — it isn't a new
// completion.
function withCompletedAt(patch, previousStatus) {
  if (!('status' in patch)) return patch;
  if (patch.status === 'done') {
    if (previousStatus !== 'done') patch.completedAt = new Date();
    // else: already done — leave completedAt exactly as it was.
  } else {
    patch.completedAt = null;
  }
  return patch;
}

// `<input type="date">` (used by the task modal) sends a date-only string
// like "2026-09-15", which Prisma's DateTime scalar rejects outright
// ("Expected ISO-8601 DateTime") — only the Calendar page's own
// `date.toISOString()` calls happened to already be full datetimes. Coerce
// here so any caller can send either shape.
function withNormalizedDueDate(patch) {
  if ('dueDate' in patch) patch.dueDate = patch.dueDate ? new Date(patch.dueDate) : null;
  return patch;
}

exports.create = async (data, userId) => {
  const patch = {};
  for (const key of WRITABLE_FIELDS) if (key in data) patch[key] = data[key];
  withCompletedAt(patch);
  withNormalizedDueDate(patch);

  // Every task belongs to a workspace, even a solo user's — mirrors
  // page.service.js#create's identical default-to-own-workspace fallback,
  // and keeps a solo account's tasks consistent with the ones the backfill
  // migration already gave a workspaceId to (see
  // scripts/backfill-task-workspace.js). Invisible to a solo user either
  // way: `getAll` with no `workspaceId` param still reads `WHERE userId = ?`.
  // An *explicit* workspaceId (a teammate creating directly into a shared
  // client workspace) needs a write-access check first — same reasoning as
  // page.service.js#create.
  let workspaceId = data.workspaceId;
  if (workspaceId) {
    if (!(await workspaceService.canAccess(workspaceId, userId, 'write'))) {
      throw AppError.forbidden('You do not have write access to that workspace');
    }
  } else {
    const ws = await workspaceService.getDefault(userId);
    workspaceId = ws.id;
  }
  // Defaults to the creator — correct for every solo task (see the same
  // reasoning in the backfill script) and overridable by an explicit
  // assigneeId when creating into a shared workspace.
  const assigneeId = 'assigneeId' in data ? data.assigneeId : userId;

  // count+create wrapped in a Serializable transaction so two concurrent
  // creates can't both read the same count and collide on `position`.
  const task = await prisma.$transaction(
    async (tx) => {
      const count = await tx.task.count({ where: { userId } });
      return tx.task.create({ data: { ...patch, userId, workspaceId, assigneeId, position: count } });
    },
    { isolationLevel: 'Serializable' }
  );
  activityLog.log('created', userId, { taskId: task.id, description: `Created "${task.title}"` });
  return task;
};

// Owner, or a workspace editor with write access to the task's workspace
// (see PLAN "Total scope" §A — "every Task query/mutation" routes through
// the same check Page/Block writes now do). Access is verified with an
// explicit fetch-then-check rather than folding `userId` into the
// `updateMany` WHERE clause, because that clause can no longer express "is
// this caller allowed" — a non-owner editor's update would otherwise just
// silently match zero rows and look identical to "not found".
exports.update = async (id, data, userId) => {
  const patch = {};
  for (const key of [...WRITABLE_FIELDS, 'position', 'assigneeId']) if (key in data) patch[key] = data[key];

  // Fetched up front both to authorize and to detect a genuine todo→done
  // transition — without the latter, re-sending status:'done' on an
  // already-done task (bulk-complete selecting a mixed set, a fast
  // double-click, etc.) would look identical to a first-time completion.
  const existing = await prisma.task.findUnique({ where: { id }, select: { userId: true, workspaceId: true, status: true } });
  if (!existing) throw AppError.notFound('Task not found');
  const isOwner = existing.userId === userId;
  if (!isOwner && !(await workspaceService.canAccess(existing.workspaceId, userId, 'write'))) {
    throw AppError.notFound('Task not found');
  }
  const isNewCompletion = patch.status === 'done' && existing.status !== 'done';

  withCompletedAt(patch, existing.status);
  withNormalizedDueDate(patch);

  const task = await prisma.task.update({ where: { id }, data: patch });

  // Only a genuine first-time completion is the interesting activity-feed
  // moment (and spawns the next recurrence) — a redundant re-completion is
  // a no-op, not a second "Completed" event.
  if (isNewCompletion) {
    activityLog.log('completed', userId, { taskId: task.id, description: `Completed "${task.title}"` });
    if (task.recurrence) await spawnNextOccurrence(task);
  } else {
    activityLog.log('updated', userId, { taskId: task.id, description: `Updated "${task.title}"` });
  }
  return task;
};

exports.remove = async (id, userId) => {
  const existing = await prisma.task.findUnique({ where: { id }, select: { userId: true, workspaceId: true, title: true } });
  if (!existing) throw AppError.notFound('Task not found');
  const isOwner = existing.userId === userId;
  if (!isOwner && !(await workspaceService.canAccess(existing.workspaceId, userId, 'write'))) {
    throw AppError.notFound('Task not found');
  }
  await prisma.task.delete({ where: { id } });
  activityLog.log('deleted', userId, { description: `Deleted "${existing.title}"` });
  return { deleted: true };
};
